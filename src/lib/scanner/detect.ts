/**
 * Lightweight card-rectangle detection for the live preview overlay.
 *
 * The full single-shot pipeline in /scan runs six OpenCV strategies plus
 * relaxation and grid inference — too slow to drive a per-frame overlay.
 * This version runs only Canny on a downscaled grayscale Mat so it fits
 * comfortably inside ~30 ms on a mid-range phone, leaving the main thread
 * free for the video pipeline.
 *
 * Returns plain corner arrays (not cv.Mats) so the caller never has to
 * worry about WASM-heap lifetimes.
 */

import { loadOpenCV } from './opencv.js';

export type QuickRect = {
	corners: Array<[number, number]>;
	rect: { x: number; y: number; width: number; height: number };
	area: number;
};

export type DetectQuickOptions = {
	/** Long-edge resolution for the analysis Mat. Default 720. */
	maxEdge?: number;
	/** Minimum candidate area as fraction of the analyzed image area. Default 0.01. */
	minAreaFrac?: number;
	/** Maximum candidate area as fraction. Default 0.6. */
	maxAreaFrac?: number;
};

let busy = false;

/**
 * True while a `detectCardsQuick` call is in flight on the same thread.
 * The live overlay should skip a frame rather than queue calls — OpenCV.js
 * is single-threaded and concurrent reentry just stalls everything.
 */
export function isQuickBusy(): boolean {
	return busy;
}

/**
 * Run a fast Canny-based card detection on the given canvas.
 * The canvas is treated as read-only; corner coordinates are returned
 * in the canvas's own pixel coordinate space (not the downscaled space).
 */
export async function detectCardsQuick(
	srcCanvas: HTMLCanvasElement,
	opts: DetectQuickOptions = {}
): Promise<QuickRect[]> {
	if (busy) return [];
	busy = true;
	try {
		await loadOpenCV();
		const cv = (window as unknown as { cv: any }).cv;
		const maxEdge = opts.maxEdge ?? 720;
		const minAreaFrac = opts.minAreaFrac ?? 0.01;
		const maxAreaFrac = opts.maxAreaFrac ?? 0.6;

		// Downscale to keep the per-frame cost predictable.
		const longEdge = Math.max(srcCanvas.width, srcCanvas.height);
		const scale = longEdge > maxEdge ? maxEdge / longEdge : 1;
		const w = Math.max(1, Math.round(srcCanvas.width * scale));
		const h = Math.max(1, Math.round(srcCanvas.height * scale));

		const work = document.createElement('canvas');
		work.width = w;
		work.height = h;
		const wctx = work.getContext('2d');
		if (!wctx) return [];
		wctx.drawImage(srcCanvas, 0, 0, w, h);

		const src = cv.imread(work);
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

			const imgArea = w * h;
			const minArea = imgArea * minAreaFrac;
			const maxArea = imgArea * maxAreaFrac;
			const invScale = 1 / scale;

			for (let i = 0; i < contours.size(); i++) {
				const contour = contours.get(i);
				const area = cv.contourArea(contour);
				if (area < minArea || area > maxArea) continue;

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
					if (aspect <= 0.5 || aspect >= 0.95) continue;

					const corners: Array<[number, number]> = [];
					for (let k = 0; k < 4; k++) {
						corners.push([
							used.data32S[k * 2] * invScale,
							used.data32S[k * 2 + 1] * invScale
						]);
					}
					candidates.push({
						corners,
						rect: {
							x: rect.x * invScale,
							y: rect.y * invScale,
							width: rect.width * invScale,
							height: rect.height * invScale
						},
						area: area * invScale * invScale
					});
				} finally {
					approx.delete();
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

		// Containment filter: drop any rect whose center sits inside a larger one.
		candidates.sort((a, b) => b.area - a.area);
		const kept: QuickRect[] = [];
		for (const c of candidates) {
			const cx = c.rect.x + c.rect.width / 2;
			const cy = c.rect.y + c.rect.height / 2;
			const inside = kept.some((k) => {
				return cx > k.rect.x && cx < k.rect.x + k.rect.width
					&& cy > k.rect.y && cy < k.rect.y + k.rect.height;
			});
			if (!inside) kept.push(c);
		}
		return kept;
	} finally {
		busy = false;
	}
}
