/**
 * Geometry of the "rows" scan mode: cards laid out in overlapping rows.
 *
 * The guide on /scan asks for rows of fanned cards: every card lies on top of
 * the previous one, shifted to the right, so that the left part of the card
 * below stays visible (the start of its name and the collector corner at the
 * bottom left); the last card of a row is fully visible; the next row lies
 * below without covering the row above. Laying cards out like this takes a
 * fraction of the time a grid of separate cards takes, and fits two rows of
 * fifteen cards into one photo.
 *
 * Nothing of a covered card is rectangular any more, so the card detection of
 * the other modes does not apply. What every row does show is a *comb*: the
 * left edges of its cards are long, nearly parallel straight lines of one card
 * height, a fraction of a card width apart (the "teeth"), and to the right of
 * every tooth runs the black border of the card on top. This module finds the
 * combs among the straight line segments of a photo (overlap-cv.ts extracts
 * them), and turns each tooth into a card: its full quadrilateral (the card
 * height is the tooth's length, the width follows from the 63 x 88 mm card)
 * and the visible strip up to the next tooth.
 *
 * Orientation: the photo may be rotated by 90, 180 or 270 degrees; every
 * rotation is tried and the most consistent comb wins. A rotated hypothesis
 * finds the same teeth mirrored, so the side of each tooth on which the dark
 * card border runs decides between 0 and 180 degrees (with a grayscale copy;
 * without it the upright reading is kept).
 *
 * Pure: segments, the image size and an optional grayscale buffer in, plain
 * numbers out, so the unit tests and the Node experiment run it without a
 * browser (scripts/scanner-harness/overlap-detect-experiment.mjs).
 */

/** A straight line segment: x1, y1, x2, y2 in image pixels. */
export type Segment = [number, number, number, number];
export type Pt = [number, number];
/** A single-channel image: `data[y * width + x]`, 0-255. */
export type GrayImage = { data: ArrayLike<number>; width: number; height: number };

/** Short side / long side of a Magic card (63 x 88 mm). */
export const CARD_ASPECT = 63 / 88;

/**
 * How a card's left edge was established: a line found in the photo, a line
 * inserted between two found ones where the spacing says one is missing (and
 * the image shows a card border there), or a line added before the first one
 * of a row where the image shows the strip of a card whose left edge vanished
 * against a dark background.
 */
export type StripEdge = 'detected' | 'inserted' | 'extended';

export type StripCard = {
	/** The full card, in image pixels: top-left, top-right, bottom-right, bottom-left of the upright card. */
	corners: [Pt, Pt, Pt, Pt];
	/** The visible part: from the card's left edge to the next card's left edge (the whole card for the last one). */
	strip: [Pt, Pt, Pt, Pt];
	/** Visible fraction of the card's width, (0, 1]. */
	visible: number;
	/** The card is fully visible (the last card of its row). */
	full: boolean;
	row: number;
	/** Position in the row, 0 = the bottom-most card of the stack (left end). */
	index: number;
	edge: StripEdge;
};

export type OverlapLayout = {
	cards: StripCard[];
	rows: number;
	/** Median card height in pixels. */
	cardHeight: number;
	/**
	 * Rotation of the cards in the photo in degrees, clockwise: 0 = upright,
	 * 90 = the card tops point to the right, 180 = upside down, 270 = to the left
	 * (plus the measured tilt).
	 */
	rotation: number;
	/** Consistency score of the winning hypothesis (higher is better). */
	score: number;
	log: string[];
};

export type OverlapOptions = {
	/** Largest deviation of a tooth from the dominant direction, degrees. Default 40 (arced rows, perspective). */
	maxToothTilt?: number;
	/** Shortest tooth, as a fraction of the row's typical tooth. Default 0.5. */
	minToothFraction?: number;
	/** Teeth closer than this fraction of the card height are one edge (outer edge and inner border edge). Default 0.06. */
	mergeFraction?: number;
	/** Log every row of every hypothesis with its evidence (experiments). */
	verbose?: boolean;
};

// ---------------------------------------------------------------- frame helpers

type Frame = { cos: number; sin: number; cx: number; cy: number };

/** A frame rotated by -theta about the image centre: card tops point to -y when the hypothesis is right. */
function makeFrame(thetaDeg: number, width: number, height: number): Frame {
	const t = (thetaDeg * Math.PI) / 180;
	return { cos: Math.cos(t), sin: Math.sin(t), cx: width / 2, cy: height / 2 };
}
function toFrame(f: Frame, [x, y]: Pt): Pt {
	const dx = x - f.cx, dy = y - f.cy;
	return [dx * f.cos + dy * f.sin, -dx * f.sin + dy * f.cos];
}
function fromFrame(f: Frame, [x, y]: Pt): Pt {
	return [f.cx + x * f.cos - y * f.sin, f.cy + x * f.sin + y * f.cos];
}

/** A segment in a frame, top end first (smaller y). */
type Line = { top: Pt; bot: Pt; len: number; /** degrees from the frame's +x axis, [0, 180) */ angle: number };

function frameLine(f: Frame, s: Segment): Line {
	let a = toFrame(f, [s[0], s[1]]), b = toFrame(f, [s[2], s[3]]);
	if (a[1] > b[1]) [a, b] = [b, a];
	const dx = b[0] - a[0], dy = b[1] - a[1];
	let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
	if (angle < 0) angle += 180;
	return { top: a, bot: b, len: Math.hypot(dx, dy), angle: angle % 180 };
}

/** x of a near-vertical line at height y (extrapolated). */
function xAt(l: Line, y: number): number {
	const dy = l.bot[1] - l.top[1];
	if (Math.abs(dy) < 1e-6) return (l.top[0] + l.bot[0]) / 2;
	return l.top[0] + ((y - l.top[1]) * (l.bot[0] - l.top[0])) / dy;
}

/** Unit vector along a near-vertical line, pointing down (+y). */
function downDir(l: Line): Pt {
	const dx = l.bot[0] - l.top[0], dy = l.bot[1] - l.top[1];
	const n = Math.hypot(dx, dy) || 1;
	return [dx / n, dy / n];
}

/** The card's right direction for a left edge pointing down: the down vector turned 90 degrees counter-clockwise on screen. */
function rightOf(down: Pt): Pt {
	return [down[1], -down[0]];
}

const add = (a: Pt, b: Pt, k = 1): Pt => [a[0] + b[0] * k, a[1] + b[1] * k];
const median = (v: number[]): number => {
	if (!v.length) return 0;
	const s = [...v].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (v: number[], q: number): number => {
	if (!v.length) return 0;
	const s = [...v].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};

// ---------------------------------------------------------------- dominant direction

/**
 * The dominant edge direction modulo 90 degrees, in (-45, 45]: card edges come
 * in two perpendicular families, and both vote for the same axis. Length-
 * weighted histogram with 0.5-degree bins, smoothed circularly, refined by the
 * weighted mean around the peak.
 */
export function dominantAxis(segments: Segment[]): number {
	const bins = 180;
	const hist = new Float64Array(bins);
	const entries: Array<{ a: number; w: number }> = [];
	for (const [x1, y1, x2, y2] of segments) {
		const len = Math.hypot(x2 - x1, y2 - y1);
		if (len < 1) continue;
		let a = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
		a = ((a % 90) + 90) % 90;
		entries.push({ a, w: len });
		hist[Math.min(bins - 1, Math.floor(a * 2))] += len;
	}
	if (!entries.length) return 0;
	const smooth = new Float64Array(bins);
	for (let i = 0; i < bins; i++) {
		for (let k = -6; k <= 6; k++) smooth[i] += hist[(i + k + bins) % bins] * Math.exp(-(k * k) / 18);
	}
	let peak = 0;
	for (let i = 1; i < bins; i++) if (smooth[i] > smooth[peak]) peak = i;
	const centre = (peak + 0.5) / 2;
	let sum = 0, wsum = 0;
	for (const { a, w } of entries) {
		let d = a - centre;
		if (d > 45) d -= 90;
		if (d < -45) d += 90;
		if (Math.abs(d) > 5) continue;
		sum += d * w;
		wsum += w;
	}
	let axis = centre + (wsum ? sum / wsum : 0);
	if (axis > 45) axis -= 90;
	return axis;
}

/**
 * The value with the largest length-weighted support within +-tol (relative),
 * preferring longer values: the length of a row's teeth among all near-vertical
 * segments (the left edges of the cards are the longest consistent group; art
 * and text boxes give shorter ones).
 */
export function supportMode(values: number[], tol = 0.1): number {
	let best = 0, bestScore = -1;
	for (const v of values) {
		let s = 0;
		for (const u of values) if (Math.abs(u - v) <= tol * v) s += u;
		const score = s * Math.sqrt(v);
		if (score > bestScore) {
			bestScore = score;
			best = v;
		}
	}
	return best;
}

// ---------------------------------------------------------------- luminance probes

type Sampler = (p: Pt) => number;

function makeSampler(gray: GrayImage | undefined, f: Frame): Sampler | null {
	if (!gray) return null;
	const { data, width, height } = gray;
	return (p) => {
		const [x, y] = fromFrame(f, p);
		const xi = Math.round(x), yi = Math.round(y);
		if (xi < 0 || yi < 0 || xi >= width || yi >= height) return -1;
		return data[yi * width + xi];
	};
}

/**
 * Which side of a card edge the dark border runs on: the median luminance of a
 * band left of the line minus that of a thin band right of it. Positive for
 * the left edge of a card lying on a lighter card (the border is on the
 * right), negative for the right edge of the last card or for a mirrored
 * reading.
 */
function borderSide(sample: Sampler, top: Pt, bot: Pt, h: number): number {
	const down: Pt = [(bot[0] - top[0]) / (Math.hypot(bot[0] - top[0], bot[1] - top[1]) || 1), (bot[1] - top[1]) / (Math.hypot(bot[0] - top[0], bot[1] - top[1]) || 1)];
	const right = rightOf(down);
	const len = Math.hypot(bot[0] - top[0], bot[1] - top[1]);
	const left: number[] = [], inner: number[] = [];
	for (let i = 0; i <= 16; i++) {
		const p = add(top, down, len * (0.12 + (0.76 * i) / 16));
		for (const k of [0.02, 0.035, 0.05]) {
			const v = sample(add(p, right, -k * h));
			if (v >= 0) left.push(v);
		}
		for (const k of [0.008, 0.016]) {
			const v = sample(add(p, right, k * h));
			if (v >= 0) inner.push(v);
		}
	}
	if (left.length < 8 || inner.length < 8) return 0;
	return median(left) - median(inner);
}

/** 5th-95th percentile luminance spread and the mean inside a quadrilateral (frame coordinates). */
function quadContent(sample: Sampler, q: [Pt, Pt, Pt, Pt]): { spread: number; mean: number; inside: number } {
	const vals: number[] = [];
	let outside = 0;
	for (let i = 1; i < 12; i++) {
		for (let j = 1; j < 16; j++) {
			const u = i / 12, v = j / 16;
			const top = add(q[0], [q[1][0] - q[0][0], q[1][1] - q[0][1]], u);
			const bot = add(q[3], [q[2][0] - q[3][0], q[2][1] - q[3][1]], u);
			const p = add(top, [bot[0] - top[0], bot[1] - top[1]], v);
			const s = sample(p);
			if (s < 0) outside++;
			else vals.push(s);
		}
	}
	const total = vals.length + outside;
	return { spread: quantile(vals, 0.95) - quantile(vals, 0.05), mean: vals.reduce((a, b) => a + b, 0) / (vals.length || 1), inside: total ? vals.length / total : 0 };
}

// ---------------------------------------------------------------- comb in one frame

type Tooth = { line: Line; members: Line[]; s: number; top: number; bot: number; edge: StripEdge; side: number; notches: number };

type RowModel = { teeth: Tooth[]; cardH: number; rightEdge: Tooth | null; spacing: number; log: string };

type CombResult = { rows: RowModel[]; score: number; log: string[] };

/** Union-find over indices. */
function components(n: number, linked: (i: number, j: number) => boolean): number[][] {
	const parent = Array.from({ length: n }, (_, i) => i);
	const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
	for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (linked(i, j)) parent[find(i)] = find(j);
	const groups = new Map<number, number[]>();
	for (let i = 0; i < n; i++) {
		const r = find(i);
		if (!groups.has(r)) groups.set(r, []);
		groups.get(r)!.push(i);
	}
	return [...groups.values()];
}

/** Least-squares polynomial (degree 1 or 2) y(x) with iterative trimming of outliers beyond `trim`. */
function fitCurve(pts: Pt[], degree: 1 | 2, trim: number): (x: number) => number {
	let use = pts;
	let coef = [median(pts.map((p) => p[1])), 0, 0];
	for (let iter = 0; iter < 3; iter++) {
		if (use.length < degree + 2) break;
		const x0 = use.reduce((a, p) => a + p[0], 0) / use.length;
		// normal equations on centred x
		const n = degree + 1;
		const A = Array.from({ length: n }, () => new Array(n).fill(0));
		const b = new Array(n).fill(0);
		for (const [x, y] of use) {
			const t = x - x0;
			const pw = [1, t, t * t];
			for (let r = 0; r < n; r++) {
				b[r] += pw[r] * y;
				for (let c = 0; c < n; c++) A[r][c] += pw[r] * pw[c];
			}
		}
		const sol = solve(A, b);
		if (!sol) break;
		const f = (x: number) => sol[0] + sol[1] * (x - x0) + (degree === 2 ? sol[2] * (x - x0) * (x - x0) : 0);
		coef = [sol[0], sol[1], degree === 2 ? sol[2] : 0];
		const kept = pts.filter((p) => Math.abs(p[1] - f(p[0])) <= trim);
		const x0c = x0;
		if (kept.length === use.length || kept.length < degree + 2) {
			return f;
		}
		use = kept;
		void x0c;
	}
	const x0 = use.reduce((a, p) => a + p[0], 0) / (use.length || 1);
	return (x: number) => coef[0] + coef[1] * (x - x0) + coef[2] * (x - x0) * (x - x0);
}

function solve(A: number[][], b: number[]): number[] | null {
	const n = b.length;
	const M = A.map((r, i) => [...r, b[i]]);
	for (let c = 0; c < n; c++) {
		let p = c;
		for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
		if (Math.abs(M[p][c]) < 1e-9) return null;
		[M[c], M[p]] = [M[p], M[c]];
		for (let r = 0; r < n; r++) {
			if (r === c) continue;
			const k = M[r][c] / M[c][c];
			for (let k2 = c; k2 <= n; k2++) M[r][k2] -= k * M[c][k2];
		}
	}
	return M.map((r, i) => r[n] / r[i]);
}

/** Distance from p along direction dir to the (infinite) line through a and b; Infinity when parallel. */
function rayToLine(p: Pt, dir: Pt, a: Pt, b: Pt): number {
	const ex = b[0] - a[0], ey = b[1] - a[1];
	const den = dir[0] * ey - dir[1] * ex;
	if (Math.abs(den) < 1e-9) return Infinity;
	return ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / den;
}


/**
 * Card-border notches across a candidate left edge: at the heights of the
 * light name bar, type line and text box, the card below is light left of the
 * edge, the black border of the card on top is dark right of it, and the card
 * on top is light again behind its border. Counts the heights (of five) that
 * show the notch; a dark artwork beside the edge does not hide it, which is
 * where a straight-line detector loses the edge.
 */
function notches(sample: Sampler, top: Pt, bot: Pt, cardH: number): number {
	const len = Math.hypot(bot[0] - top[0], bot[1] - top[1]) || 1;
	const down: Pt = [(bot[0] - top[0]) / len, (bot[1] - top[1]) / len];
	// a tooth starts below the card's top border
	return notchesAt(sample, add(top, down, -0.025 * cardH), down, cardH);
}

function notchesAt(sample: Sampler, cardTop: Pt, down: Pt, cardH: number): number {
	const right = rightOf(down);
	let n = 0;
	for (const f of [0.07, 0.556, 0.65, 0.75, 0.85]) {
		const p = add(cardTop, down, f * cardH);
		const a = sample(add(p, right, -0.03 * cardH)), b = sample(add(p, right, 0.012 * cardH)), c = sample(add(p, right, 0.06 * cardH));
		if (a < 0 || b < 0 || c < 0) continue;
		if (a - b > 35 && c - b > 35) n++;
	}
	return n;
}

/**
 * Light and dark bands of a card from top to bottom, in card heights: the
 * black top border, the light name bar, type line and text box, the black
 * bottom border that carries the collector lines. Nearly every frame since
 * 2003 has them (the colours of name bar and text box vary, they stay far
 * lighter than the border); artwork and frame colours are left out.
 */
const DARK_BANDS: Array<[number, number]> = [[0.006, 0.022], [0.94, 0.99]];
const LIGHT_BANDS: Array<[number, number]> = [[0.05, 0.09], [0.545, 0.57], [0.61, 0.87]];

/**
 * Where the card's top and bottom lie along its left edge: the luminance
 * profile across the visible strip, from above the card to below it, matched
 * against the bands above for every offset and scale near the estimate. The
 * teeth end where the card below meets the border, a few per cent inside the
 * card and not the same for every card; the bands put the top border, the
 * name bar and the bottom border where the strip shows them. `upright` is the
 * best match minus the best match of the bands turned upside down: positive
 * for a strip seen the right way up.
 */
type HeightFit = { dTop: number; dBot: number; score: number; upright: number };

function fitHeight(sample: Sampler, tl: Pt, bl: Pt, visible: number, near?: { dTop: number; scale: number }): HeightFit | null {
	const h0 = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
	if (h0 < 20) return null;
	const down: Pt = [(bl[0] - tl[0]) / h0, (bl[1] - tl[1]) / h0];
	const right = rightOf(down);
	const width = visible * h0 * CARD_ASPECT;
	// inside the strip, clear of the card's own left border and of the next card's
	let u0 = Math.min(0.05 * h0, 0.3 * width), u1 = width - 0.035 * h0;
	if (u1 - u0 < 0.02 * h0) { u0 = 0.3 * width; u1 = 0.7 * width; }
	// two profiles: the mean across the strip for the light bands, the darkest sample for the dark ones,
	// so the light collector text in the bottom border does not make the border look lighter than the
	// table below the card (which would pull the fitted bottom down onto a dark mat or a shadow)
	const from = -0.15, step = 0.0025, n = Math.round(1.35 / step) + 1;
	const prefixMean = new Float64Array(n + 1), prefixMin = new Float64Array(n + 1);
	let invalid = 0;
	let lastMean = 128, lastMin = 128;
	for (let i = 0; i < n; i++) {
		const p = add(tl, down, (from + i * step) * h0);
		let sum = 0, cnt = 0, min = 255;
		for (let k = 0; k < 7; k++) {
			const v = sample(add(p, right, u0 + ((u1 - u0) * k) / 6));
			if (v >= 0) { sum += v; cnt++; min = Math.min(min, v); }
		}
		if (cnt) { lastMean = sum / cnt; lastMin = min; }
		else invalid++;
		prefixMean[i + 1] = prefixMean[i] + lastMean;
		prefixMin[i + 1] = prefixMin[i] + lastMin;
	}
	if (invalid > n * 0.3) return null;
	const zone = (prefix: Float64Array, a: number, b: number) => {
		const i0 = Math.max(0, Math.min(n - 1, Math.round((a - from) / step)));
		const i1 = Math.max(i0 + 1, Math.min(n, Math.round((b - from) / step)));
		return (prefix[i1] - prefix[i0]) / (i1 - i0);
	};
	const match = (delta: number, s: number, flip: boolean) => {
		const at = (c: number) => delta + (flip ? 1 - c : c) * s;
		const band = (prefix: Float64Array, [a, b]: [number, number]) => (flip ? zone(prefix, at(b), at(a)) : zone(prefix, at(a), at(b)));
		const light = LIGHT_BANDS.reduce((x, z) => x + band(prefixMean, z), 0) / LIGHT_BANDS.length;
		const dark = DARK_BANDS.reduce((x, z) => x + band(prefixMin, z), 0) / DARK_BANDS.length;
		return light - dark;
	};
	// free: offsets and scales around the estimate; near: a narrow window around what the row's other cards show
	const [s0, s1, sStep] = near ? [near.scale - 0.02, near.scale + 0.02, 0.005] : [0.94, 1.08, 0.01];
	const [d0, d1] = near ? [near.dTop - 0.035, near.dTop + 0.035] : [-0.1, 0.1];
	const grid: Array<{ m: number; delta: number; s: number }> = [];
	let best = { m: -Infinity, delta: 0, s: 1 };
	let bestFlip = -Infinity;
	for (let s = s0; s <= s1 + 1e-6; s += sStep) {
		for (let delta = d0; delta <= d1 + 1e-6; delta += 0.0025) {
			const m = match(delta, s, false);
			grid.push({ m, delta, s });
			if (m > best.m) best = { m, delta, s };
			bestFlip = Math.max(bestFlip, match(delta, s, true));
		}
	}
	// the bands sit a little inside the card's real ones, so the best match is a plateau: take its centre
	// in the narrow window (the free window can hold two separate optima)
	if (near) {
		const top = grid.filter((g) => g.m >= best.m - 1);
		best = { m: best.m, delta: top.reduce((a, g) => a + g.delta, 0) / top.length, s: top.reduce((a, g) => a + g.s, 0) / top.length };
	}
	return { dTop: best.delta, dBot: best.delta + best.s, score: best.m, upright: best.m - bestFlip };
}

/** One near-vertical line through the endpoints of several (x = a + b y, length-weighted), spanning all of them. */
function fitVertical(lines: Line[]): Line {
	let sw = 0, sy = 0, sx = 0, syy = 0, sxy = 0;
	for (const l of lines) for (const [x, y] of [l.top, l.bot]) { const w = l.len; sw += w; sy += w * y; sx += w * x; syy += w * y * y; sxy += w * x * y; }
	const den = sw * syy - sy * sy;
	const b = Math.abs(den) < 1e-9 ? 0 : (sw * sxy - sy * sx) / den;
	const a = (sx - b * sy) / sw;
	const y0 = Math.min(...lines.map((l) => l.top[1])), y1 = Math.max(...lines.map((l) => l.bot[1]));
	const top: Pt = [a + b * y0, y0], bot: Pt = [a + b * y1, y1];
	const angle = ((Math.atan2(y1 - y0, bot[0] - top[0]) * 180) / Math.PI + 180) % 180;
	return { top, bot, len: Math.hypot(bot[0] - top[0], y1 - y0), angle };
}

function combInFrame(lines: Line[], sample: Sampler | null, shortSide: number, o: Required<OverlapOptions>): CombResult {
	const log: string[] = [];
	const vertical = lines.filter((l) => Math.abs(l.angle - 90) <= o.maxToothTilt && l.len >= 0.04 * shortSide);
	if (vertical.length < 4) return { rows: [], score: 0, log: ['too few near-vertical segments'] };

	// Rows: near-vertical lines that overlap in height by most of the shorter one. A tooth often comes
	// in pieces (where the card below is as dark as the border); the pieces of a row still overlap the
	// row's other teeth, and lines of different rows never overlap, because rows do not.
	const linked = (a: Line, b: Line) => {
		if (Math.abs(a.angle - b.angle) > 12) return false;
		const ov = Math.min(a.bot[1], b.bot[1]) - Math.max(a.top[1], b.top[1]);
		if (ov < 0.6 * Math.min(a.bot[1] - a.top[1], b.bot[1] - b.top[1])) return false;
		const ym = (Math.max(a.top[1], b.top[1]) + Math.min(a.bot[1], b.bot[1])) / 2;
		return Math.abs(xAt(a, ym) - xAt(b, ym)) <= 1.2 * Math.max(a.len, b.len);
	};
	const subs: Line[][] = [];
	for (const comp of components(vertical.length, (i, j) => linked(vertical[i], vertical[j]))) {
		const members = comp.map((i) => vertical[i]);
		if (members.length < 3) continue;
		// a long line across two rows (an edge of the table or of a mat) links them: drop the long lines and
		// split again (they come back below when they stay within one row's height)
		const ref = quantile(members.map((l) => l.len), 0.85);
		const keep = members.filter((l) => l.len <= 1.25 * ref);
		if (keep.length === members.length) subs.push(members);
		else for (const sub of components(keep.length, (i, j) => linked(keep[i], keep[j]))) if (sub.length >= 3) subs.push(sub.map((i) => keep[i]));
	}
	// The rows are the sets about as tall as the biggest one. Every other line joins the row whose height
	// it stays within and whose lines it links with, repeatedly, so a chain of pieces follows: the full
	// left edge of a first card, the right edge of a last card in pieces, a split-off bit of a row.
	const extent = (set: Line[]) => Math.max(...set.map((l) => l.bot[1])) - Math.min(...set.map((l) => l.top[1]));
	const biggest = subs.reduce<Line[] | null>((a, b) => (!a || b.length > a.length ? b : a), null);
	const memberSets = biggest ? subs.filter((set) => extent(set) >= 0.6 * extent(biggest)) : [];
	const spans = memberSets.map((set) => {
		const y0 = Math.min(...set.map((l) => l.top[1])), y1 = Math.max(...set.map((l) => l.bot[1]));
		return [y0 - 0.15 * (y1 - y0), y1 + 0.15 * (y1 - y0)];
	});
	const used = new Set<Line>(memberSets.flat());
	for (let changed = true; changed; ) {
		changed = false;
		for (const l of vertical) {
			if (used.has(l)) continue;
			const k = memberSets.findIndex((set, i) => l.top[1] >= spans[i][0] && l.bot[1] <= spans[i][1] && set.some((m) => linked(l, m)));
			if (k < 0) continue;
			memberSets[k].push(l);
			used.add(l);
			changed = true;
		}
	}

	if (o.verbose) for (const m of memberSets) log.push(`  line set: ${m.length} lines, x ${Math.min(...m.map((l) => l.top[0])).toFixed(0)}..${Math.max(...m.map((l) => l.top[0])).toFixed(0)}, y ${Math.min(...m.map((l) => l.top[1])).toFixed(0)}..${Math.max(...m.map((l) => l.bot[1])).toFixed(0)}`);
	const rows: RowModel[] = [];
	for (const members of memberSets) rows.push(...buildRow(members, sample, o));
	// top to bottom
	rows.sort((a, b) => a.teeth[0].top - b.teeth[0].top);
	log.push(`${vertical.length} near-vertical segments, ${memberSets.length} row candidate(s)`);
	for (const r of rows) log.push(r.log);
	return { rows, score: 0, log };
}

/**
 * One row from its near-vertical lines: group the lines of one edge (pieces of
 * the outer edge, the inner edge of the black border), order the teeth along
 * the row, recognise the right edge of the last card, fill a missing tooth
 * where the spacing and the image agree, add a first card whose edge vanished
 * against the background, and split where two rows lie side by side.
 */
function buildRow(members: Line[], sample: Sampler | null, o: Required<OverlapOptions>): RowModel[] {
	const ref = quantile(members.map((l) => l.len), 0.85);
	// a common reference height along the row (through the midpoints of the longer lines)
	const mids: Pt[] = members.filter((l) => l.len >= 0.35 * ref).map((l) => [(l.top[0] + l.bot[0]) / 2, (l.top[1] + l.bot[1]) / 2]);
	if (mids.length < 2) return [];
	const span = Math.max(...mids.map((p) => p[0])) - Math.min(...mids.map((p) => p[0]));
	const centre = fitCurve(mids, mids.length >= 6 && span > 3 * ref ? 2 : 1, 0.25 * ref);
	const posOf = (l: Line) => {
		let x = xAt(l, (l.top[1] + l.bot[1]) / 2);
		for (let k = 0; k < 2; k++) x = xAt(l, centre(x));
		return x;
	};
	const sorted = members.map((l) => ({ l, s: posOf(l) })).sort((a, b) => a.s - b.s);

	// one edge: the pieces of the outer edge, the inner edge of the black border, collinear bits
	const groupBy = (gap: number) => {
		const out: Array<Array<{ l: Line; s: number }>> = [];
		for (const m of sorted) {
			const g = out[out.length - 1];
			if (g && m.s - g[g.length - 1].s <= gap) g.push(m);
			else out.push([m]);
		}
		return out;
	};
	const toTooth = (g: Array<{ l: Line; s: number }>, fromRight: boolean): Tooth => {
		// the outermost substantial line is the card's own edge: the inner edge of the border lies inside the card
		const longest = Math.max(...g.map((m) => m.l.len));
		const ordered = fromRight ? [...g].reverse() : g;
		const edge = (ordered.find((m) => m.l.len >= 0.3 * longest) ?? ordered[0]).s;
		const outer = g.filter((m) => Math.abs(m.s - edge) <= 0.018 * ref);
		const line = fitVertical(outer.map((m) => m.l));
		return {
			line,
			members: g.map((m) => m.l),
			s: edge,
			top: Math.min(...g.map((m) => m.l.top[1])),
			bot: Math.max(...g.map((m) => m.l.bot[1])),
			edge: 'detected',
			side: sample ? borderSide(sample, line.top, line.bot, ref) : 0,
			notches: 0
		};
	};
	// a tooth spans most of a card height; shorter groups are lines inside a card (artwork, boxes)
	const qualify = (groups: Array<Array<{ l: Line; s: number }>>, minExtent: number | null) => {
		const candidates = groups.map((g, i) => ({ g: i, t: toTooth(g, false) }));
		const limit = minExtent ?? o.minToothFraction * quantile(candidates.map((c) => c.t.bot - c.t.top), 0.8);
		return candidates.filter((c) => c.t.bot - c.t.top >= limit);
	};
	// first pass with the line lengths as the scale, second with the card height it yields: the
	// outer edge and the inner edge of the border are about 3 % of a card height apart
	const first = qualify(groupBy(o.mergeFraction * ref), null);
	if (first.length < 2) return [];
	const firstH = quantile(first.map((c) => c.t.bot - c.t.top), 0.8);
	const groups = groupBy(Math.max(o.mergeFraction * ref, o.mergeFraction * 1.1 * firstH));
	const qualified = qualify(groups, o.minToothFraction * firstH);
	if (qualified.length < 2) return [];

	// card height: teeth end at the black borders above and below, about 2.5 % of the card each
	const cardH = quantile(qualified.map((c) => c.t.bot - c.t.top), 0.8) * 1.05;
	const cardW = cardH * CARD_ASPECT;

	// gaps between consecutive teeth, measured from each tooth along its card's width direction
	const widthTo = (a: Tooth, b: Tooth) => {
		const mid: Pt = [xAt(a.line, (a.top + a.bot) / 2), (a.top + a.bot) / 2];
		return rayToLine(mid, rightOf(downDir(a.line)), b.line.top, b.line.bot);
	};

	// two rows side by side at the same height: split where a gap exceeds a card width
	const pieces: Array<typeof qualified> = [];
	let cur: typeof qualified = [];
	for (const q of qualified) {
		if (cur.length && widthTo(cur[cur.length - 1].t, q.t) > 1.25 * cardW) {
			pieces.push(cur);
			cur = [];
		}
		cur.push(q);
	}
	if (cur.length) pieces.push(cur);
	// a lone edge a little more than a card width after a row: the right edge of a last card whose left
	// edge vanished over the card below (a dark artwork there); its left edge goes in one card width before
	const lone = new Map<(typeof pieces)[number], (typeof qualified)[number]>();
	for (let i = 0; i + 1 < pieces.length; i++) {
		const next = pieces[i + 1];
		if (next.length !== 1 || pieces[i].length < 2) continue;
		const g = widthTo(pieces[i][pieces[i].length - 1].t, next[0].t);
		if (g > 2.2 * cardW) continue;
		lone.set(pieces[i], next[0]);
		pieces.splice(i + 1, 1);
	}

	const out: RowModel[] = [];
	for (const piece of pieces) {
		let teeth = piece.map((q) => q.t);
		const gaps = teeth.slice(1).map((t, i) => widthTo(teeth[i], t));
		// the right edge of the last card: one card width after the previous tooth, while the other teeth are closer
		let rightEdge: Tooth | null = null;
		const loneEdge = lone.get(piece);
		if (loneEdge) {
			rightEdge = toTooth(groups[loneEdge.g], true);
			const right = rightOf(downDir(rightEdge.line));
			const base = shiftTooth(rightEdge, right, -cardW, 'inserted');
			let lastLeft = base;
			if (sample) {
				let bestN = 0;
				for (let off = -0.1; off <= 0.101; off += 0.02) {
					const t = shiftTooth(base, right, off * cardW, 'inserted');
					const n = notches(sample, t.line.top, t.line.bot, cardH);
					if (n > bestN) {
						bestN = n;
						lastLeft = { ...t, notches: n };
					}
				}
			}
			teeth.push(lastLeft);
			gaps.push(widthTo(teeth[teeth.length - 2], lastLeft));
		} else if (teeth.length >= 2) {
			const g = gaps[gaps.length - 1];
			const others = gaps.slice(0, -1);
			if (g >= 0.78 * cardW && g <= 1.18 * cardW && (!others.length || median(others) < 0.75 * cardW)) {
				rightEdge = toTooth(groups[piece[piece.length - 1].g], true);
				teeth = teeth.slice(0, -1);
				gaps.pop();
			}
		}
		if (!teeth.length) continue;
		const spacing = median((loneEdge ? gaps.slice(0, -1) : gaps).filter((g) => g > 0 && g < 0.95 * cardW)) || 0.33 * cardW;

		// a missing tooth: a gap of about twice the spacing with card-border notches in it
		const filled: Tooth[] = [teeth[0]];
		for (let i = 1; i < teeth.length; i++) {
			const a = filled[filled.length - 1], b = teeth[i];
			const g = widthTo(a, b);
			const k = Math.round(g / spacing);
			if (k >= 2 && g > 1.6 * spacing && sample) {
				for (let j = 1; j < k; j++) {
					const base = interpolateTooth(a, b, j / k);
					const right = rightOf(downDir(base.line));
					let bestT: Tooth | null = null, bestN = 1;
					for (let off = -0.3; off <= 0.301; off += 0.05) {
						const t = Math.abs(off) > 1e-9 ? shiftTooth(base, right, off * spacing, 'inserted') : base;
						const n = notches(sample, t.line.top, t.line.bot, cardH);
						if (n > bestN) {
							bestN = n;
							bestT = { ...t, notches: n };
						}
					}
					if (bestT) filled.push(bestT);
				}
			}
			filled.push(b);
		}
		teeth = filled;

		// a first card whose left edge vanished against a dark background: card content left of the first tooth
		if (sample) {
			const first = teeth[0];
			const right = rightOf(downDir(first.line));
			const cand = shiftTooth(first, right, -spacing, 'extended');
			const far = shiftTooth(cand, right, -0.5 * spacing, 'extended');
			const strip = quadContent(sample, [cand.line.top, first.line.top, first.line.bot, cand.line.bot]);
			const beyond = quadContent(sample, [far.line.top, cand.line.top, cand.line.bot, far.line.bot]);
			// a card strip holds its black border, the light name bar and text box: wide spread, brighter than what lies beyond
			if (strip.inside > 0.95 && strip.spread >= 70 && strip.mean > beyond.mean + 25 && beyond.spread < 0.6 * strip.spread) teeth.unshift(cand);
		}

		if (sample) for (const t of teeth) if (t.edge === 'detected') t.notches = notches(sample, t.line.top, t.line.bot, cardH);
		const detected = teeth.filter((t) => t.edge === 'detected').length;
		if (detected < 2 && !(detected >= 1 && rightEdge)) continue;
		out.push({
			teeth,
			cardH,
			rightEdge,
			spacing,
			log: `row: ${teeth.length} cards (${detected} edges found, ${teeth.length - detected} added), spacing ${(spacing / cardW).toFixed(2)} card widths, card height ${cardH.toFixed(0)} px, right edge ${rightEdge ? 'found' : 'not found'}, notches ${teeth.map((t) => t.notches).join('')}`
		});
	}
	return out;
}

function interpolateTooth(a: Tooth, b: Tooth, t: number): Tooth {
	const lerp = (p: Pt, q: Pt): Pt => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
	// the height span of the neighbours, positioned between them
	const top = lerp([xAt(a.line, a.top), a.top], [xAt(b.line, b.top), b.top]);
	const bot = lerp([xAt(a.line, a.bot), a.bot], [xAt(b.line, b.bot), b.bot]);
	const line: Line = { top, bot, len: Math.hypot(bot[0] - top[0], bot[1] - top[1]), angle: ((Math.atan2(bot[1] - top[1], bot[0] - top[0]) * 180) / Math.PI + 180) % 180 };
	return { line, members: [], s: a.s + (b.s - a.s) * t, top: top[1], bot: bot[1], edge: 'inserted', side: 0, notches: 0 };
}

function shiftTooth(t: Tooth, dir: Pt, k: number, edge: StripEdge): Tooth {
	const top = add([xAt(t.line, t.top), t.top], dir, k);
	const bot = add([xAt(t.line, t.bot), t.bot], dir, k);
	return { line: { top, bot, len: t.line.len, angle: t.line.angle }, members: [], s: t.s + k, top: top[1], bot: bot[1], edge, side: 0, notches: 0 };
}

// ---------------------------------------------------------------- cards

type FrameCard = { corners: Pt[]; strip: Pt[]; visible: number; full: boolean; row: number; index: number; edge: StripEdge; evidence: number; fit: number };

/** Minimum band contrast for a card's own height fit; weaker fits take the row's smoothed top and bottom. */
const FIT_CONFIDENT = 30;

function cardsOfRow(row: RowModel, rowIndex: number, sample: Sampler | null, log?: string[]): FrameCard[] {
	const { teeth, cardH } = row;
	// first estimate from the teeth: smooth the ends along the row, single teeth stop short where the card below is dark
	const deg = teeth.length >= 6 ? 2 : 1;
	const topAt = fitCurve(teeth.map((t) => [t.s, t.top] as Pt), deg, 0.04 * cardH);
	const botAt = fitCurve(teeth.map((t) => [t.s, t.bot] as Pt), deg, 0.04 * cardH);
	const pad = 0.025 * cardH;
	const ends = teeth.map((t) => {
		const down = downDir(t.line);
		const yTop = Math.min(t.top, topAt(t.s) + 0.02 * cardH);
		const yBot = Math.max(t.bot, botAt(t.s) - 0.02 * cardH);
		let tl = add([xAt(t.line, yTop), yTop], down, -pad);
		let bl = add([xAt(t.line, yBot), yBot], down, pad);
		if (Math.abs(Math.hypot(bl[0] - tl[0], bl[1] - tl[1]) - cardH) > 0.07 * cardH) {
			// a tooth much too short or too long: keep its middle, take the row's card height
			const mid: Pt = [(tl[0] + bl[0]) / 2, (tl[1] + bl[1]) / 2];
			tl = add(mid, down, -cardH / 2);
			bl = add(mid, down, cardH / 2);
		}
		return { tl, bl, down };
	});
	const visibleOf = (i: number, tl: Pt, bl: Pt) => {
		if (i === teeth.length - 1) return 1;
		const h = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
		const mid: Pt = [(tl[0] + bl[0]) / 2, (tl[1] + bl[1]) / 2];
		const n = teeth[i + 1];
		return Math.max(0.05, Math.min(1, rayToLine(mid, rightOf(ends[i].down), n.line.top, n.line.bot) / (h * CARD_ASPECT)));
	};

	// then each card's own top and bottom from the bands of its strip: a free fit for every card, the
	// row's trend through the confident ones, and a second fit of every card in a narrow window around
	// that trend (a free fit can lock onto the wrong band where the artwork is light); weak fits follow
	// their neighbours
	const free = ends.map((e, i) => (sample ? fitHeight(sample, e.tl, e.bl, visibleOf(i, e.tl, e.bl)) : null));
	let fits = free;
	if (sample) {
		const sure = fits.map((f, i) => ({ f, i })).filter((x) => x.f && x.f.score >= FIT_CONFIDENT);
		if (sure.length >= 2) {
			const d = sure.length >= 6 ? 2 : 1;
			const topFit = fitCurve(sure.map((x) => [teeth[x.i].s, x.f!.dTop] as Pt), d, 0.03);
			const botFit = fitCurve(sure.map((x) => [teeth[x.i].s, x.f!.dBot] as Pt), d, 0.03);
			fits = ends.map((e, i) => fitHeight(sample, e.tl, e.bl, visibleOf(i, e.tl, e.bl), { dTop: topFit(teeth[i].s), scale: botFit(teeth[i].s) - topFit(teeth[i].s) }));
			ends.forEach((e, i) => {
				const f = fits[i];
				const h = Math.hypot(e.bl[0] - e.tl[0], e.bl[1] - e.tl[1]);
				const own = !!f && f.score >= FIT_CONFIDENT / 2;
				if (log) log.push(`    card ${i}: fit ${f ? `${f.dTop.toFixed(3)}..${f.dBot.toFixed(3)} score ${f.score.toFixed(0)} upright ${f.upright.toFixed(0)}` : '-'}, curve ${topFit(teeth[i].s).toFixed(3)}..${botFit(teeth[i].s).toFixed(3)}${own ? ' own' : ''}`);
				const dTop = own ? f!.dTop : topFit(teeth[i].s), dBot = own ? f!.dBot : botFit(teeth[i].s);
				const tl = add(e.tl, e.down, dTop * h);
				e.bl = add(e.tl, e.down, dBot * h);
				e.tl = tl;
			});
		} else if (sure.length === 1) {
			const f = sure[0].f!;
			ends.forEach((e) => {
				const h = Math.hypot(e.bl[0] - e.tl[0], e.bl[1] - e.tl[1]);
				const tl = add(e.tl, e.down, f.dTop * h);
				e.bl = add(e.tl, e.down, f.dBot * h);
				e.tl = tl;
			});
		}
	}

	return ends.map((e, i) => {
		const { tl, bl, down } = e;
		const right = rightOf(down);
		const h = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
		const w = h * CARD_ASPECT;
		const visible = visibleOf(i, tl, bl);
		const t = teeth[i];
		let evidence = t.edge === 'detected' ? 1 : 0.5;
		if (sample) {
			// the border notches of its left edge and which way up its strip is
			const notch = t.edge === 'inserted' ? t.notches : notchesAt(sample, tl, down, h);
			const f = free[i];
			evidence = notch / 5 + (f ? Math.max(-1, Math.min(1, f.upright / 60)) : 0);
		}
		return {
			corners: [tl, add(tl, right, w), add(bl, right, w), bl],
			strip: [tl, add(tl, right, visible * w), add(bl, right, visible * w), bl],
			visible,
			full: i === teeth.length - 1,
			row: rowIndex,
			index: i,
			edge: t.edge,
			evidence,
			fit: free[i]?.score ?? 0
		};
	});
}

type RowPick = { row: RowModel; cards: FrameCard[]; ev: number[]; mean: number };

/** Minimum mean evidence per card of a row (border notches / 5 plus the upright vote, at most 2). */
const ROW_EVIDENCE = 0.6;

function insideQuad(p: Pt, q: Pt[]): boolean {
	let sign = 0;
	for (let i = 0; i < 4; i++) {
		const a = q[i], b = q[(i + 1) % 4];
		const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
		if (Math.abs(c) < 1e-9) continue;
		if (sign && Math.sign(c) !== sign) return false;
		sign = Math.sign(c);
	}
	return true;
}

/**
 * The rows of one hypothesis that hold up: evidence per card (the border
 * notches of its left edge and which way up its strip is), the same card size
 * as the strongest row, and no card lying on a card of a stronger row. A wrong
 * hypothesis also finds "rows" (text lines and the grain of a table turned on
 * their side) but neither notches nor upright name bars, and its rows pile up
 * on each other; a mirrored one finds the real teeth with both upside down.
 * Rows come back top to bottom.
 */
function selectRows(rows: RowModel[], sample: Sampler | null, log?: string[]): RowPick[] {
	const evaluated: RowPick[] = rows.map((row, i) => {
		const fitLog: string[] | undefined = log ? [] : undefined;
		let cards = cardsOfRow(row, i, sample, fitLog);
		// an edge of the table or of a mat beside a row: a strip at either end with no card bands and no notches
		const bogus = (c: FrameCard) => !!sample && c.fit < FIT_CONFIDENT / 2 && c.evidence < 0.3;
		while (cards.length > 2 && (bogus(cards[0]) || bogus(cards[cards.length - 1]))) {
			const teeth = bogus(cards[0]) ? row.teeth.slice(1) : row.teeth.slice(0, -1);
			row = { ...row, teeth, log: `${row.log}, end trimmed` };
			cards = cardsOfRow(row, i, sample);
		}
		const ev = cards.map((c) => c.evidence);
		if (log) log.push(`  ${row.log}; evidence ${ev.map((e) => e.toFixed(1)).join(' ')}`, ...fitLog!);
		return { row, cards, ev, mean: ev.reduce((a, b) => a + b, 0) / (ev.length || 1) };
	});
	const strong = evaluated.filter((r) => !sample || r.mean >= ROW_EVIDENCE).sort((a, b) => b.ev.reduce((x, y) => x + y, 0) - a.ev.reduce((x, y) => x + y, 0));
	if (!strong.length) return [];
	const refH = strong[0].row.cardH;
	const kept: RowPick[] = [];
	for (const r of strong) {
		if (Math.abs(r.row.cardH / refH - 1) > 0.2) continue;
		const keep = r.cards.map((c) => {
			const centre: Pt = [(c.strip[0][0] + c.strip[2][0]) / 2, (c.strip[0][1] + c.strip[2][1]) / 2];
			return !kept.some((k) => k.cards.some((o) => insideQuad(centre, o.corners)));
		});
		if (keep.filter(Boolean).length < 2) continue;
		if (keep.every(Boolean)) kept.push(r);
		else {
			const idx = keep.map((k, i) => (k ? i : -1)).filter((i) => i >= 0);
			kept.push({ row: { ...r.row, teeth: idx.map((i) => r.row.teeth[i]) }, cards: idx.map((i) => r.cards[i]), ev: idx.map((i) => r.ev[i]), mean: idx.reduce((a, i) => a + r.ev[i], 0) / idx.length });
		}
	}
	return kept.sort((a, b) => a.cards[0].corners[0][1] - b.cards[0].corners[0][1]);
}

/**
 * The overlapping rows of a photo from its line segments: every card with its
 * full quadrilateral and its visible strip, or null when no row of at least two
 * cards is found. `gray` (same pixel grid as the segments) enables the
 * upright / upside-down decision, filling a missing edge and the first card of
 * a row on a dark background; without it the upright reading wins ties.
 */
export function detectOverlapRows(segments: Segment[], width: number, height: number, gray?: GrayImage, opts: OverlapOptions = {}): OverlapLayout | null {
	const o: Required<OverlapOptions> = { maxToothTilt: 40, minToothFraction: 0.5, mergeFraction: 0.06, verbose: false, ...opts };
	const axis = dominantAxis(segments);
	const shortSide = Math.min(width, height);
	const log: string[] = [`dominant edge direction ${axis.toFixed(1)} deg, ${segments.length} segments`];
	let best: { theta: number; rows: RowModel[]; cards: FrameCard[]; frame: Frame; score: number; log: string[] } | null = null;
	for (const rot of [0, 90, 180, 270]) {
		const theta = axis + rot;
		const frame = makeFrame(theta, width, height);
		const sample = makeSampler(gray, frame);
		const comb = combInFrame(segments.map((s) => frameLine(frame, s)), sample, shortSide, o);
		const detail: string[] | undefined = o.verbose ? [] : undefined;
		const picked = selectRows(comb.rows, sample, detail);
		const score = picked.reduce((a, r) => a + r.ev.reduce((x, y) => x + y, 0), 0);
		log.push(`rotation ${rot}: score ${score.toFixed(1)}, ${picked.length} of ${comb.rows.length} row(s) kept (evidence per card ${comb.rows.length ? picked.map((r) => r.mean.toFixed(2)).join(' ') || '-' : '-'}), ${picked.reduce((a, r) => a + r.cards.length, 0)} card(s)`);
		if (detail) log.push(...detail);
		if (!best || score > best.score) {
			best = {
				theta,
				rows: picked.map((r) => r.row),
				cards: picked.flatMap((r, i) => r.cards.map((c, k) => ({ ...c, row: i, index: k }))),
				frame,
				score,
				log: [...comb.log, ...picked.map((r, i) => `kept row ${i}: ${r.cards.length} cards, evidence ${r.mean.toFixed(2)} per card`)]
			};
		}
	}
	if (!best || !best.rows.length) return null;
	log.push(...best.log);
	const frame = best.frame;
	const cards: StripCard[] = best.cards.map((c) => ({
		...c,
		corners: c.corners.map((p) => fromFrame(frame, p)) as StripCard['corners'],
		strip: c.strip.map((p) => fromFrame(frame, p)) as StripCard['strip']
	}));
	const rotation = ((best.theta % 360) + 360) % 360;
	return { cards, rows: best.rows.length, cardHeight: median(best.rows.map((r) => r.cardH)), rotation, score: best.score, log };
}
