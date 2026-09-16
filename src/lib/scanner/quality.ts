/**
 * Frame quality for the live scanner: sharpness and glare over the card
 * regions, plus the selection of the best frame while the scene holds still.
 *
 * - Sharpness is the variance of the Laplacian (4-neighbour kernel) over the
 *   region: motion blur and misfocus flatten the edges and drive it down. The
 *   absolute value depends on the content and the resolution, so it is only
 *   compared between frames of the same scene, never against a fixed
 *   threshold.
 * - Glare is the fraction of blown-out pixels (all channels near white) in
 *   the region: specular reflections on a foil or a glossy card erase the
 *   text underneath.
 * - The score combines both; `BestFrameSelector` keeps the best-scoring frame
 *   of the recent window so the capture uses it instead of whatever frame
 *   happened to be current when the stabiliser fired.
 *
 * Plain typed-array arithmetic so it runs in a Web Worker and in unit tests.
 */

export type Box = { x: number; y: number; width: number; height: number };

export type FrameQuality = {
	/** Variance of the Laplacian over the regions (0 when nothing could be measured). */
	sharpness: number;
	/** Fraction of near-white pixels in the regions, 0..1. */
	glare: number;
	/** Sharpness discounted by glare; higher is better. */
	score: number;
};

/** Glare fraction at which the score reaches zero. */
export const GLARE_FULL = 0.1;
/** Channel value from which a pixel counts as blown out. */
export const SATURATION_LEVEL = 250;

function clipBox(box: Box, width: number, height: number): Box | null {
	const x1 = Math.max(0, Math.floor(box.x));
	const y1 = Math.max(0, Math.floor(box.y));
	const x2 = Math.min(width, Math.ceil(box.x + box.width));
	const y2 = Math.min(height, Math.ceil(box.y + box.height));
	if (x2 - x1 < 3 || y2 - y1 < 3) return null;
	return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** Luma of an RGBA buffer. */
export function toGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
	const gray = new Uint8Array(width * height);
	for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
		gray[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
	}
	return gray;
}

/**
 * Variance of the 4-neighbour Laplacian inside `roi` (clipped to the image,
 * one-pixel border excluded). 0 for regions too small to measure.
 */
export function laplacianVariance(gray: Uint8Array, width: number, height: number, roi: Box): number {
	const box = clipBox(roi, width, height);
	if (!box) return 0;
	const x1 = Math.max(1, box.x);
	const y1 = Math.max(1, box.y);
	const x2 = Math.min(width - 1, box.x + box.width);
	const y2 = Math.min(height - 1, box.y + box.height);
	if (x2 - x1 < 1 || y2 - y1 < 1) return 0;
	let sum = 0;
	let sumSq = 0;
	let n = 0;
	for (let y = y1; y < y2; y++) {
		const row = y * width;
		for (let x = x1; x < x2; x++) {
			const i = row + x;
			const l = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
			sum += l;
			sumSq += l * l;
			n++;
		}
	}
	if (n === 0) return 0;
	const mean = sum / n;
	return sumSq / n - mean * mean;
}

/** Fraction of pixels inside `roi` whose R, G and B all reach `level`. */
export function saturatedFraction(
	rgba: Uint8ClampedArray | Uint8Array,
	width: number,
	height: number,
	roi: Box,
	level = SATURATION_LEVEL
): number {
	const box = clipBox(roi, width, height);
	if (!box) return 0;
	let hot = 0;
	let n = 0;
	for (let y = box.y; y < box.y + box.height; y++) {
		let p = (y * width + box.x) * 4;
		for (let x = 0; x < box.width; x++, p += 4) {
			if (rgba[p] >= level && rgba[p + 1] >= level && rgba[p + 2] >= level) hot++;
			n++;
		}
	}
	return n === 0 ? 0 : hot / n;
}

/**
 * Quality of a frame over the given regions (the tracked cards); the whole
 * frame when no region is given. Sharpness and glare are area-weighted means
 * over the regions.
 */
export function assessFrame(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, rois: Box[]): FrameQuality {
	const regions = rois.length ? rois : [{ x: 0, y: 0, width, height }];
	const gray = toGray(rgba, width, height);
	let sharpSum = 0;
	let glareSum = 0;
	let areaSum = 0;
	for (const roi of regions) {
		const box = clipBox(roi, width, height);
		if (!box) continue;
		const area = box.width * box.height;
		sharpSum += laplacianVariance(gray, width, height, box) * area;
		glareSum += saturatedFraction(rgba, width, height, box) * area;
		areaSum += area;
	}
	if (areaSum === 0) return { sharpness: 0, glare: 0, score: 0 };
	const sharpness = sharpSum / areaSum;
	const glare = glareSum / areaSum;
	return { sharpness, glare, score: sharpness * Math.max(0, 1 - glare / GLARE_FULL) };
}

export type BestFrameOptions = {
	/** A best frame older than this is replaced by the next frame regardless of its score. Default 2500 ms. */
	windowMs?: number;
	/** A frame must beat the current best by this factor to replace it (avoids re-snapshotting on noise). Default 1.15. */
	improveFactor?: number;
	/** Sharpness below this fraction of the recent best counts as blurry. Default 0.5. */
	blurFrac?: number;
	/** Glare above this fraction counts as a glare hint. Default 0.03. */
	glareHint?: number;
};

/**
 * Tracks the best-scoring frame of the current scene. The caller snapshots
 * the frame's pixels whenever `offer()` returns true and resets when the
 * scene changes, so the snapshot always shows the scene that is captured.
 */
export class BestFrameSelector {
	private readonly windowMs: number;
	private readonly improveFactor: number;
	private readonly blurFrac: number;
	private readonly glareHint: number;
	private best: { quality: FrameQuality; at: number } | null = null;

	constructor(opts: BestFrameOptions = {}) {
		this.windowMs = opts.windowMs ?? 2500;
		this.improveFactor = opts.improveFactor ?? 1.15;
		this.blurFrac = opts.blurFrac ?? 0.5;
		this.glareHint = opts.glareHint ?? 0.03;
	}

	/** True when the offered frame should become the new best (snapshot it). */
	offer(quality: FrameQuality, at: number): boolean {
		if (!this.best || at - this.best.at > this.windowMs || quality.score > this.best.quality.score * this.improveFactor) {
			this.best = { quality, at };
			return true;
		}
		return false;
	}

	/** The best frame's quality and age, or null after a reset. */
	current(at: number): { quality: FrameQuality; ageMs: number } | null {
		if (!this.best) return null;
		return { quality: this.best.quality, ageMs: at - this.best.at };
	}

	/**
	 * Short hint for the viewfinder: 'blurry' when the frame is far less sharp
	 * than the best recent one, 'glare' when highlights are blown out, '' otherwise.
	 */
	hint(quality: FrameQuality, at: number): 'blurry' | 'glare' | '' {
		if (this.best && at - this.best.at <= this.windowMs && this.best.quality.sharpness > 0 && quality.sharpness < this.best.quality.sharpness * this.blurFrac) {
			return 'blurry';
		}
		if (quality.glare > this.glareHint) return 'glare';
		return '';
	}

	reset(): void {
		this.best = null;
	}
}
