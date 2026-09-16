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

export type QuickRect = {
	corners: Array<[number, number]>;
	rect: { x: number; y: number; width: number; height: number };
	area: number;
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
	 * Accepted short/long edge ratio of the bounding box. An MTG card is
	 * 63x88 mm (0.716); the defaults 0.55-0.88 leave room for perspective
	 * while rejecting near-square shapes such as keycaps.
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
	const coordScale = opts.coordScale ?? 1;

	const src = cv.matFromArray(height, width, cv.CV_8UC4, rgba);
	const gray = new cv.Mat();
	const blurred = new cv.Mat();
	const edges = new cv.Mat();
	const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
	const contours = new cv.MatVector();
	const hier = new cv.Mat();
	const candidates: QuickRect[] = [];

	try {
		cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
		cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
		cv.Canny(blurred, edges, 50, 150);
		cv.dilate(edges, edges, kernel);
		cv.findContours(edges, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

		const imgArea = width * height;
		const minArea = imgArea * minAreaFrac;
		const maxArea = imgArea * maxAreaFrac;

		for (let i = 0; i < contours.size(); i++) {
			const contour = contours.get(i);
			const area = cv.contourArea(contour);
			if (area < minArea || area > maxArea) {
				contour.delete();
				continue;
			}

			const perimeter = cv.arcLength(contour, true);
			let approx = new cv.Mat();
			let used: any = null;
			try {
				for (const eps of [0.02, 0.03, 0.04]) {
					cv.approxPolyDP(contour, approx, eps * perimeter, true);
					if (approx.rows === 4) {
						used = approx;
						break;
					}
					approx.delete();
					approx = new cv.Mat();
				}
				if (!used) {
					// Fallback: 5-8 sides → minAreaRect
					cv.approxPolyDP(contour, approx, 0.02 * perimeter, true);
					if (approx.rows >= 5 && approx.rows <= 8) {
						const rotRect = cv.minAreaRect(contour);
						const verts = cv.RotatedRect.points(rotRect);
						const rectMat = new cv.Mat(4, 1, cv.CV_32SC2);
						for (let k = 0; k < 4; k++) {
							rectMat.data32S[k * 2] = Math.round(verts[k].x);
							rectMat.data32S[k * 2 + 1] = Math.round(verts[k].y);
						}
						approx.delete();
						approx = rectMat;
						used = approx;
					}
				}
				if (!used) continue;

				const rect = cv.boundingRect(used);
				const aspect = Math.min(rect.width, rect.height) / Math.max(rect.width, rect.height);
				if (aspect < minAspect || aspect > maxAspect) continue;

				const corners: Array<[number, number]> = [];
				for (let k = 0; k < 4; k++) {
					corners.push([used.data32S[k * 2] * coordScale, used.data32S[k * 2 + 1] * coordScale]);
				}
				candidates.push({
					corners,
					rect: {
						x: rect.x * coordScale,
						y: rect.y * coordScale,
						width: rect.width * coordScale,
						height: rect.height * coordScale
					},
					area: area * coordScale * coordScale
				});
			} finally {
				approx.delete();
				contour.delete();
			}
		}
	} finally {
		src.delete();
		gray.delete();
		blurred.delete();
		edges.delete();
		kernel.delete();
		contours.delete();
		hier.delete();
	}

	return postFilterRects(candidates, minRelativeArea);
}

/**
 * Containment filter: drop any rect whose center sits inside a larger one.
 * Then drop anything far smaller than the largest survivor — in a hand-held
 * scene the cards are about the same size, so tiny extra rectangles are
 * clutter (keycaps, badges, phone icons), not cards.
 */
export function postFilterRects(candidates: QuickRect[], minRelativeArea = 0.25): QuickRect[] {
	const sorted = [...candidates].sort((a, b) => b.area - a.area);
	const kept: QuickRect[] = [];
	for (const c of sorted) {
		const cx = c.rect.x + c.rect.width / 2;
		const cy = c.rect.y + c.rect.height / 2;
		const inside = kept.some((k) => {
			return cx > k.rect.x && cx < k.rect.x + k.rect.width && cy > k.rect.y && cy < k.rect.y + k.rect.height;
		});
		if (!inside) kept.push(c);
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
