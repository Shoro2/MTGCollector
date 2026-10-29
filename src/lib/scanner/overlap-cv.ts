/**
 * OpenCV glue of the "rows" scan mode (overlapping cards, see overlap.ts):
 * straight line segments of a photo, the only image evidence the row model
 * needs besides a grayscale copy for its luminance checks.
 *
 * Takes the OpenCV module and a grayscale cv.Mat at detection scale and
 * returns plain number arrays, so callers never hold WASM-heap objects, and
 * the same code runs in the page and in the Node experiment
 * (scripts/scanner-harness/overlap-detect-experiment.mjs).
 */
import type { Segment } from './overlap.js';

export type SegmentPassOptions = {
	/** Gaussian blur kernel (odd). */
	blur: number;
	/** Canny thresholds. */
	lo: number;
	hi: number;
	/** Shortest segment, as a fraction of the image's short side. */
	minLength: number;
	/** Largest gap HoughLinesP bridges, as a fraction of the image's short side. */
	maxGap: number;
	/** Accumulator threshold, as a fraction of the image's short side. */
	votes: number;
};

/**
 * Two passes like the live detector's: a fine one for sharp edges and a
 * coarse, strongly blurred one on a half-size copy, where the weave of a
 * play mat averages out and the step between a black border and the mat
 * survives (CLAUDE.md §6.2).
 */
export const SEGMENT_PASSES: Array<SegmentPassOptions & { scale: number }> = [
	{ scale: 1, blur: 5, lo: 40, hi: 120, minLength: 0.045, maxGap: 0.006, votes: 0.025 },
	{ scale: 0.5, blur: 5, lo: 15, hi: 45, minLength: 0.045, maxGap: 0.008, votes: 0.025 }
];

/** Line segments of a grayscale image (both passes), in the image's pixel coordinates. */
export function extractSegments(cv: any, gray: any, passes = SEGMENT_PASSES): Segment[] {
	const out: Segment[] = [];
	for (const p of passes) {
		const src = new cv.Mat();
		const blurred = new cv.Mat();
		const edges = new cv.Mat();
		const lines = new cv.Mat();
		try {
			if (p.scale !== 1) cv.resize(gray, src, new cv.Size(Math.round(gray.cols * p.scale), Math.round(gray.rows * p.scale)), 0, 0, cv.INTER_AREA);
			else gray.copyTo(src);
			const s = Math.min(src.cols, src.rows);
			cv.GaussianBlur(src, blurred, new cv.Size(p.blur, p.blur), 0);
			cv.Canny(blurred, edges, p.lo, p.hi, 3, true);
			cv.HoughLinesP(edges, lines, 1, Math.PI / 360, Math.max(10, Math.round(p.votes * s)), Math.max(8, p.minLength * s), Math.max(2, p.maxGap * s));
			const k = 1 / p.scale;
			for (let i = 0; i < lines.rows; i++) {
				const d = lines.data32S;
				out.push([d[i * 4] * k, d[i * 4 + 1] * k, d[i * 4 + 2] * k, d[i * 4 + 3] * k]);
			}
		} finally {
			src.delete(); blurred.delete(); edges.delete(); lines.delete();
		}
	}
	return out;
}
