/**
 * Quadrilateral sanity checks for card candidates (pure, unit-tested).
 *
 * A contour approximated to four points is not yet a card: phone captures
 * produced bow-ties, triangles with a fourth point and patches of a woven
 * play mat (2026-09-17). A candidate has to be a convex, roughly rectangular
 * quadrilateral of card proportions — measured on its own sides, so a rotated
 * card is judged like an upright one — and, for the live detector, it has to
 * *contain* something: a card spans from its black border to its bright text
 * box, a patch of background texture does not.
 */

export type Pt = [number, number];

export type CardQuadOptions = {
	/** Accepted short/long side ratio. A card is 63x88 mm (0.716). */
	minAspect?: number;
	maxAspect?: number;
	/** Accepted interior angles in degrees; perspective skews a card by some 20 degrees at most. */
	minAngle?: number;
	maxAngle?: number;
	/** Minimum ratio between the two sides of an opposite pair (shorter / longer). */
	minOppositeRatio?: number;
};

/** The four points in polygon order (by angle around their centroid), so side i runs from point i to point i + 1. */
export function polygonOrder(pts: Pt[]): Pt[] {
	const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
	const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
	return [...pts].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Side lengths of a quad in polygon order. */
export function quadSides(q: Pt[]): number[] {
	return q.map((p, i) => dist(p, q[(i + 1) % q.length]));
}

/** Interior angles (degrees) of a quad in polygon order; a reflex or collapsed corner shows up as > 180 or ~0 / ~180. */
export function quadAngles(q: Pt[]): number[] {
	const n = q.length;
	// orientation of the polygon, so interior angles come out the same for both winding directions
	let area2 = 0;
	for (let i = 0; i < n; i++) area2 += q[i][0] * q[(i + 1) % n][1] - q[(i + 1) % n][0] * q[i][1];
	const sign = area2 >= 0 ? 1 : -1;
	return q.map((p, i) => {
		const prev = q[(i + n - 1) % n], next = q[(i + 1) % n];
		const ax = prev[0] - p[0], ay = prev[1] - p[1];
		const bx = next[0] - p[0], by = next[1] - p[1];
		const cross = (bx * ay - by * ax) * sign;
		const dot = ax * bx + ay * by;
		let deg = (Math.atan2(cross, dot) * 180) / Math.PI;
		if (deg < 0) deg += 360;
		return deg;
	});
}

/** Short/long ratio of a quad from the means of its opposite sides — rotation invariant, unlike a bounding box. */
export function quadAspect(pts: Pt[]): number {
	if (pts.length !== 4) return 0;
	const s = quadSides(polygonOrder(pts));
	const a = (s[0] + s[2]) / 2, b = (s[1] + s[3]) / 2;
	const long = Math.max(a, b);
	return long > 0 ? Math.min(a, b) / long : 0;
}

/**
 * Whether four points form a card-shaped quadrilateral: convex, every corner
 * within the angle window, opposite sides of similar length, side ratio
 * within the aspect window.
 */
export function isPlausibleCardQuad(pts: Pt[], opts: CardQuadOptions = {}): boolean {
	if (pts.length !== 4 || pts.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return false;
	const minAspect = opts.minAspect ?? 0.55;
	const maxAspect = opts.maxAspect ?? 0.88;
	const minAngle = opts.minAngle ?? 55;
	const maxAngle = opts.maxAngle ?? 125;
	const minOpposite = opts.minOppositeRatio ?? 0.6;
	const q = polygonOrder(pts);
	const sides = quadSides(q);
	if (sides.some((s) => s < 1)) return false;
	for (const a of quadAngles(q)) if (a < minAngle || a > maxAngle) return false;
	for (const [i, j] of [[0, 2], [1, 3]]) {
		if (Math.min(sides[i], sides[j]) / Math.max(sides[i], sides[j]) < minOpposite) return false;
	}
	const aspect = quadAspect(q);
	return aspect >= minAspect && aspect <= maxAspect;
}

/**
 * Luminance (0-255) on an nx x ny grid inside a quad of an RGBA buffer. The
 * grid is interpolated bilinearly between the corners and stays `inset` away
 * from the sides, so neither the background next to a card nor the rounded
 * corners are sampled. Every sample is the mean of a (2 x radius + 1) px window
 * (every second pixel): point samples of a woven play mat measured the weave
 * itself (spread 58-72, the same as a foil card under glare, 63-77); averaged,
 * the weave flattens while a card keeps its border-to-text-box range. Points
 * outside the frame are clamped to it.
 */
export function sampleQuadLuminance(
	rgba: Uint8ClampedArray | Uint8Array,
	width: number,
	height: number,
	pts: Pt[],
	nx = 16,
	ny = 22,
	inset = 0.06,
	radius = 3
): number[] {
	const q = polygonOrder(pts);
	const out: number[] = [];
	for (let j = 0; j < ny; j++) {
		const v = inset + ((1 - 2 * inset) * (j + 0.5)) / ny;
		for (let i = 0; i < nx; i++) {
			const u = inset + ((1 - 2 * inset) * (i + 0.5)) / nx;
			// q[0]→q[1] is one side, q[3]→q[2] the opposite one
			const tx = q[0][0] + (q[1][0] - q[0][0]) * u, ty = q[0][1] + (q[1][1] - q[0][1]) * u;
			const bx = q[3][0] + (q[2][0] - q[3][0]) * u, by = q[3][1] + (q[2][1] - q[3][1]) * u;
			const x = Math.min(width - 1, Math.max(0, Math.round(tx + (bx - tx) * v)));
			const y = Math.min(height - 1, Math.max(0, Math.round(ty + (by - ty) * v)));
			// mean over a small window: a fine background texture averages out, the large areas of a card do not
			let sum = 0;
			let n = 0;
			for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy += 2) {
				for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx += 2) {
					const k = (yy * width + xx) * 4;
					sum += 0.299 * rgba[k] + 0.587 * rgba[k + 1] + 0.114 * rgba[k + 2];
					n++;
				}
			}
			out.push(sum / n);
		}
	}
	return out;
}

/** Spread between two percentiles of the samples (default 5th to 95th): a card is wide, a patch of texture narrow. */
export function luminanceSpread(samples: number[], lo = 0.05, hi = 0.95): number {
	if (samples.length === 0) return 0;
	const s = [...samples].sort((a, b) => a - b);
	const at = (f: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(f * (s.length - 1))))];
	return at(hi) - at(lo);
}
