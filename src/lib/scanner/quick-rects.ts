/**
 * Core of the lightweight card-rectangle detection for the live preview.
 *
 * The full single-shot pipeline in /scan runs six OpenCV strategies plus
 * relaxation and grid inference — too slow to drive a per-frame overlay.
 * This version runs only Canny on a downscaled grayscale Mat so it fits
 * comfortably inside ~30 ms on a mid-range phone. Its filters are
 * deliberately stricter than the full pipeline's: the live scanner
 * auto-captures whatever it tracks, so background rectangles (keyboard keys,
 * stickers) must not qualify.
 *
 * The function takes the OpenCV module and an RGBA pixel buffer, nothing
 * else, so the very same code runs on the main thread (`detect.ts`) and in
 * the detection Web Worker (`detect-worker.ts`). Results are plain corner
 * arrays (not cv.Mats), so callers never have to worry about WASM-heap
 * lifetimes.
 */

import { assessFrame, type FrameQuality } from './quality.js';
import { isPlausibleCardQuad, luminanceSpread, polygonOrder, quadSides, sampleQuadLuminance, type Pt } from './quad.js';
import { touchesFrameEdge } from './geometry.js';

export type QuickRect = {
	corners: Array<[number, number]>;
	rect: { x: number; y: number; width: number; height: number };
	area: number;
	/** Which pass found it: the fine edge map or the coarse one (textured / low-contrast backgrounds). */
	source?: 'fine' | 'coarse';
	/** 5th-95th percentile luminance spread inside the quad (0-255). */
	spread?: number;
};

export type DetectQuickOptions = {
	/**
	 * Minimum candidate area as fraction of the analyzed image area. Default
	 * 0.03: anything smaller is too small to OCR anyway, and the higher floor
	 * keeps keyboard keys, stickers and UI buttons in the background from
	 * being tracked as cards.
	 */
	minAreaFrac?: number;
	/** Maximum candidate area as fraction. Default 0.6. */
	maxAreaFrac?: number;
	/**
	 * Accepted short/long side ratio of the quadrilateral itself (rotation
	 * invariant). An MTG card is 63x88 mm (0.716); the defaults 0.55-0.88
	 * leave room for perspective while rejecting near-square shapes such as
	 * keycaps.
	 */
	minAspect?: number;
	maxAspect?: number;
	/**
	 * Drop candidates whose area is below this fraction of the largest
	 * candidate. Default 0.25. In a hand-held scene the cards are roughly the
	 * same size; much smaller rectangles are background clutter.
	 */
	minRelativeArea?: number;
	/**
	 * Minimum 5th-95th percentile luminance spread inside a candidate (window
	 * means, see sampleQuadLuminance). A card reaches from its black border to
	 * its bright text box; a four-cornered patch of a woven play mat does not.
	 * Measured: mat patches and sleeved card backs 10-32, real cards from 39
	 * (foils under glare on a hazy phone photo) to 185. Default 30.
	 */
	minSpread?: number;
	/**
	 * Second pass on a half-resolution, strongly blurred copy with low Canny
	 * thresholds. Background texture (a woven play mat, wood grain) averages
	 * out at that scale while the step between the card's border and the
	 * background survives; on the fine edge map the texture's edge mesh fuses
	 * with the card outline and no four-cornered contour is left. Default true.
	 */
	coarse?: boolean;
	/**
	 * Multiplier applied to every returned coordinate. Lets a caller hand in
	 * an already-downscaled frame and still get results in the original
	 * (e.g. full video) pixel space. Default 1.
	 */
	coordScale?: number;
};

export type QuickDetection = {
	rects: QuickRect[];
	/** Sharpness/glare over the detected rectangles (whole frame when none). */
	quality: FrameQuality;
};

/** A contour that fills its minimum-area rectangle this well is a (rounded, blurred) rectangle. */
const RECT_FILL = 0.9;

/**
 * Four corners for a contour: a 4-point polygon approximation, or the
 * minimum-area rectangle when the contour is a 5-8-gon or fills that
 * rectangle (rounded corners and a blurred edge map give many vertices).
 */
function quadFromContour(cv: any, contour: any): Pt[] | null {
	const perimeter = cv.arcLength(contour, true);
	const approx = new cv.Mat();
	try {
		for (const eps of [0.02, 0.03, 0.04]) {
			cv.approxPolyDP(contour, approx, eps * perimeter, true);
			if (approx.rows === 4) {
				const pts: Pt[] = [];
				for (let k = 0; k < 4; k++) pts.push([approx.data32S[k * 2], approx.data32S[k * 2 + 1]]);
				return pts;
			}
		}
		cv.approxPolyDP(contour, approx, 0.02 * perimeter, true);
		let rectLike = approx.rows >= 5 && approx.rows <= 8;
		const rotRect = cv.minAreaRect(contour);
		if (!rectLike) {
			const hull = new cv.Mat();
			try {
				cv.convexHull(contour, hull);
				const rectArea = rotRect.size.width * rotRect.size.height;
				rectLike = rectArea > 0 && cv.contourArea(hull) / rectArea >= RECT_FILL;
			} finally {
				hull.delete();
			}
		}
		if (!rectLike) return null;
		return cv.RotatedRect.points(rotRect).map((p: { x: number; y: number }) => [p.x, p.y] as Pt);
	} finally {
		approx.delete();
	}
}

export type CardQuadPassOptions = {
	/** Gaussian blur kernel (odd) and Canny thresholds. */
	blur: number;
	lo: number;
	hi: number;
	/** Contour area window as fractions of the input's area. */
	minAreaFrac: number;
	maxAreaFrac: number;
	minAspect?: number;
	maxAspect?: number;
};

/** The coarse pass: run it on a copy scaled down to about this long edge (half the 720 px live frame). */
export const COARSE_LONG_EDGE = 360;
export const COARSE_PASS = { blur: 9, lo: 15, hi: 45 } as const;

/**
 * One detection pass over a gray Mat: blur, Canny, dilate, external contours,
 * four corners per contour (quadFromContour), card-shaped quads only. Returns
 * the quads in the input's own pixel space with their contour area. Shared by
 * the live detector (fine + coarse pass) and the upload pipeline's fallback
 * for a lone card on a textured background.
 */
export function findCardQuads(cv: any, input: any, o: CardQuadPassOptions): Array<{ quad: Pt[]; area: number }> {
	const blurred = new cv.Mat();
	const edges = new cv.Mat();
	const contours = new cv.MatVector();
	const hier = new cv.Mat();
	const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
	const out: Array<{ quad: Pt[]; area: number }> = [];
	try {
		cv.GaussianBlur(input, blurred, new cv.Size(o.blur, o.blur), 0);
		cv.Canny(blurred, edges, o.lo, o.hi);
		cv.dilate(edges, edges, kernel);
		cv.findContours(edges, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
		const passArea = input.cols * input.rows;
		for (let i = 0; i < contours.size(); i++) {
			const contour = contours.get(i);
			try {
				const area = cv.contourArea(contour);
				if (area < passArea * o.minAreaFrac || area > passArea * o.maxAreaFrac) continue;
				const quad = quadFromContour(cv, contour);
				if (!quad || !isPlausibleCardQuad(quad, { minAspect: o.minAspect, maxAspect: o.maxAspect })) continue;
				if (polygonArea(quad) > passArea * o.maxAreaFrac) continue;
				out.push({ quad, area });
			} finally {
				contour.delete();
			}
		}
	} finally {
		blurred.delete();
		edges.delete();
		contours.delete();
		hier.delete();
		kernel.delete();
	}
	return out;
}

/**
 * Canny + contour scan over an RGBA buffer. Coordinates are returned in the
 * buffer's pixel space times `coordScale`.
 */
export function scanQuickRects(
	cv: any,
	rgba: Uint8ClampedArray | Uint8Array,
	width: number,
	height: number,
	opts: DetectQuickOptions = {}
): QuickRect[] {
	const minAreaFrac = opts.minAreaFrac ?? 0.03;
	const maxAreaFrac = opts.maxAreaFrac ?? 0.6;
	const minAspect = opts.minAspect ?? 0.55;
	const maxAspect = opts.maxAspect ?? 0.88;
	const minRelativeArea = opts.minRelativeArea ?? 0.25;
	const minSpread = opts.minSpread ?? 30;
	const coordScale = opts.coordScale ?? 1;

	const src = cv.matFromArray(height, width, cv.CV_8UC4, rgba);
	const gray = new cv.Mat();
	const candidates: QuickRect[] = [];

	// One pass over `input` (a gray Mat at 1/div of the buffer); the content check runs on the full buffer.
	const pass = (input: any, div: number, blur: number, lo: number, hi: number, source: 'fine' | 'coarse') => {
		for (const { quad, area } of findCardQuads(cv, input, { blur, lo, hi, minAreaFrac, maxAreaFrac, minAspect, maxAspect })) {
			const pts = quad.map((q) => [q[0] * div, q[1] * div] as Pt);
			const spread = luminanceSpread(sampleQuadLuminance(rgba, width, height, pts));
			if (spread < minSpread) continue;
			const xs = pts.map((q) => q[0]);
			const ys = pts.map((q) => q[1]);
			const x0 = Math.min(...xs);
			const y0 = Math.min(...ys);
			candidates.push({
				corners: pts.map((q) => [q[0] * coordScale, q[1] * coordScale] as [number, number]),
				rect: { x: x0 * coordScale, y: y0 * coordScale, width: (Math.max(...xs) - x0) * coordScale, height: (Math.max(...ys) - y0) * coordScale },
				area: area * div * div * coordScale * coordScale,
				source,
				spread
			});
		}
	};

	try {
		cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
		pass(gray, 1, 5, 50, 150, 'fine');
		if (opts.coarse !== false) {
			const div = Math.max(1, Math.round(Math.max(width, height) / COARSE_LONG_EDGE));
			const small = new cv.Mat();
			try {
				cv.resize(gray, small, new cv.Size(Math.round(width / div), Math.round(height / div)), 0, 0, cv.INTER_AREA);
				pass(small, div, COARSE_PASS.blur, COARSE_PASS.lo, COARSE_PASS.hi, 'coarse');
			} finally {
				small.delete();
			}
		}
	} finally {
		src.delete();
		gray.delete();
	}

	return postFilterRects(preferFine(candidates), minRelativeArea, { width: width * coordScale, height: height * coordScale });
}

/** Area of a quadrilateral given in any corner order (shoelace over the polygon order). */
function polygonArea(pts: Pt[]): number {
	const q = polygonOrder(pts);
	let a = 0;
	for (let i = 0; i < q.length; i++) a += q[i][0] * q[(i + 1) % q.length][1] - q[(i + 1) % q.length][0] * q[i][1];
	return Math.abs(a) / 2;
}

const boxIoU = (a: QuickRect['rect'], b: QuickRect['rect']): number => {
	const x1 = Math.max(a.x, b.x);
	const y1 = Math.max(a.y, b.y);
	const x2 = Math.min(a.x + a.width, b.x + b.width);
	const y2 = Math.min(a.y + a.height, b.y + b.height);
	if (x2 <= x1 || y2 <= y1) return 0;
	const inter = (x2 - x1) * (y2 - y1);
	return inter / (a.width * a.height + b.width * b.height - inter);
};

/** Both passes usually find a card on a plain background: keep the fine quad, its corners are the precise ones. */
export function preferFine(candidates: QuickRect[]): QuickRect[] {
	const fine = candidates.filter((c) => c.source !== 'coarse');
	return candidates.filter((c) => c.source !== 'coarse' || !fine.some((f) => boxIoU(f.rect, c.rect) >= 0.7));
}

/** Mean short and long side of a quad. */
function quadDims(c: QuickRect): { short: number; long: number } {
	const s = quadSides(polygonOrder(c.corners as Pt[]));
	const a = (s[0] + s[2]) / 2;
	const b = (s[1] + s[3]) / 2;
	return { short: Math.min(a, b), long: Math.max(a, b) };
}

/**
 * Whether `inner` has the size of an inner box of the card `outer`: the art
 * box and the text box span ~85% of the card's width and 44% / 30% of its
 * height.
 */
export function isInnerBoxOf(inner: QuickRect, outer: QuickRect): boolean {
	const i = quadDims(inner);
	const o = quadDims(outer);
	if (o.short <= 0 || o.long <= 0) return false;
	const across = i.long / o.short;
	const along = i.short / o.long;
	return across >= 0.72 && across <= 0.97 && along >= 0.2 && along <= 0.55;
}

/** How many sides of `outer` the candidate `inner` lies along (bounding boxes, within 4.5% of the outer size). */
function sharedSides(inner: QuickRect, outer: QuickRect): number {
	const tx = outer.rect.width * 0.045;
	const ty = outer.rect.height * 0.045;
	let shared = 0;
	if (Math.abs(inner.rect.x - outer.rect.x) <= tx) shared++;
	if (Math.abs(inner.rect.x + inner.rect.width - (outer.rect.x + outer.rect.width)) <= tx) shared++;
	if (Math.abs(inner.rect.y - outer.rect.y) <= ty) shared++;
	if (Math.abs(inner.rect.y + inner.rect.height - (outer.rect.y + outer.rect.height)) <= ty) shared++;
	return shared;
}

/**
 * Whether `outer` is a blob of several cards rather than one card. The coarse
 * pass merges touching cards, and two cards side by side are 126x88 mm, four
 * in a block 126x176 mm — card-shaped again (0.70 / 0.716). Its members are
 * card-shaped themselves and lie along its sides. One card has at most *one*
 * inner rectangle of card proportions (the art box, 0.73; "name bar + art" is
 * 0.83, the text box 0.49) — and with the outline found on the card's inner
 * frame those inner rectangles lie along its sides as well, so a single
 * card-shaped inner candidate only counts when it spans the full width of the
 * container (a card's art box reaches 0.85-0.93 of it). This rule once threw
 * away the outline of a black card in favour of its "name bar + art" block.
 */
export function isCardBlob(outer: QuickRect, inners: QuickRect[]): boolean {
	const od = quadDims(outer);
	const members = inners.filter((c) => {
		if (c.area < outer.area * 0.2 || sharedSides(c, outer) < 2) return false;
		const d = quadDims(c);
		const aspect = d.long > 0 ? d.short / d.long : 0;
		return aspect >= 0.66 && aspect <= 0.78;
	});
	if (members.length >= 2) return true;
	return members.some((c) => sharedSides(c, outer) >= 3 && quadDims(c).long >= od.short * 0.97);
}

/**
 * Containment filter: drop any rect whose center sits inside a larger one —
 * the art box and the text box of a card are rectangles too. Two kinds of
 * container are not cards and go instead of what they hold: a rectangle that
 * reaches the frame edge and holds a fully visible card-shaped candidate that
 * is not one of its inner boxes (a print on the play mat, the table edge),
 * and a blob of several cards (the coarse pass merges touching cards; its
 * members lie along the blob's sides). Then drop anything far smaller than
 * the largest survivor — in a hand-held scene the cards are about the same
 * size, so tiny extra rectangles are clutter (keycaps, badges, phone icons),
 * not cards.
 */
export function postFilterRects(candidates: QuickRect[], minRelativeArea = 0.25, frame?: { width: number; height: number }): QuickRect[] {
	const margin = frame ? Math.max(frame.width, frame.height) * 0.01 : 0;
	const cutOff = (c: QuickRect) => !!frame && touchesFrameEdge(c.rect, frame.width, frame.height, margin);
	const holds = (k: QuickRect, c: QuickRect) => {
		const cx = c.rect.x + c.rect.width / 2;
		const cy = c.rect.y + c.rect.height / 2;
		return c !== k && c.area < k.area && cx > k.rect.x && cx < k.rect.x + k.rect.width && cy > k.rect.y && cy < k.rect.y + k.rect.height;
	};
	const background = new Set(
		candidates.filter((k) => {
			const inners = candidates.filter((c) => holds(k, c));
			return isCardBlob(k, inners) || (cutOff(k) && inners.some((c) => !cutOff(c) && !isInnerBoxOf(c, k)));
		})
	);
	const sorted = candidates.filter((c) => !background.has(c)).sort((a, b) => b.area - a.area);
	const kept: QuickRect[] = [];
	for (const c of sorted) {
		if (!kept.some((k) => holds(k, c))) kept.push(c);
	}
	if (kept.length === 0) return kept;
	const largest = kept[0].area;
	return kept.filter((c) => c.area >= largest * minRelativeArea);
}

/**
 * Detection plus frame quality over the detected rectangles, on one RGBA
 * buffer. The quality is measured in the buffer's own pixel space.
 */
export function detectOnPixels(
	cv: any,
	rgba: Uint8ClampedArray | Uint8Array,
	width: number,
	height: number,
	opts: DetectQuickOptions = {}
): QuickDetection {
	const rects = scanQuickRects(cv, rgba, width, height, opts);
	const inv = 1 / (opts.coordScale ?? 1);
	const rois = rects.map((r) => ({
		x: r.rect.x * inv,
		y: r.rect.y * inv,
		width: r.rect.width * inv,
		height: r.rect.height * inv
	}));
	return { rects, quality: assessFrame(rgba, width, height, rois) };
}
