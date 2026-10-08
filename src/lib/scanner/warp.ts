/** Browser-side warp helpers shared by full recognition and the live replacement check. */
import { orderCornersForCard } from './geometry';
import { artBoxOnWarp, hashArtPixels } from './phash';

export function expandedCardCorners(points: Array<[number, number]>, expand = true): Array<[number, number]> {
	const q = orderCornersForCard(points);
	if (!expand) return q;
	const ex = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) * 0.05;
	const ey = Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]) * 0.05;
	const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
	return q.map(([x, y]) => {
		const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
		if (!d) return [x, y];
		const amount = Math.hypot(dx / d * ex, dy / d * ey);
		// Keep the margin at image edges too; OpenCV pads out-of-frame samples with black.
		return [Math.round(x + dx / d * amount), Math.round(y + dy / d * amount)];
	});
}

/** The reference artwork window in both orientations, including the warp's margin. */
export function artHashesOfWarp(canvas: HTMLCanvasElement): { hash: string; alt: string } {
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx || canvas.width < 16 || canvas.height < 16) return { hash: '', alt: '' };
	const box = artBoxOnWarp();
	const w = Math.max(1, Math.round(canvas.width * box.w));
	const h = Math.max(1, Math.round(canvas.height * box.h));
	const x = Math.round(canvas.width * box.x), y = Math.round(canvas.height * box.y);
	const upright = ctx.getImageData(x, y, w, h).data;
	const mirrored = ctx.getImageData(canvas.width - x - w, canvas.height - y - h, w, h).data;
	const reversed = new Uint8ClampedArray(mirrored.length);
	for (let i = 0, j = mirrored.length - 4; i < mirrored.length; i += 4, j -= 4) {
		reversed[i] = mirrored[j]; reversed[i + 1] = mirrored[j + 1];
		reversed[i + 2] = mirrored[j + 2]; reversed[i + 3] = 255;
	}
	return { hash: hashArtPixels(upright, w, h, 4), alt: hashArtPixels(reversed, w, h, 4) };
}

/** Small, bounded warp; never loads another OCR engine or sends image pixels. */
export function liveArtHashes(canvas: HTMLCanvasElement, corners: Array<[number, number]>) {
	const cv = (window as any).cv;
	const mats: any[] = [];
	const keep = (mat: any) => { mats.push(mat); return mat; };
	try {
		const src = keep(cv.imread(canvas));
		const from = keep(cv.matFromArray(4, 1, cv.CV_32FC2, expandedCardCorners(corners).flat()));
		const to = keep(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, 488, 0, 488, 680, 0, 680]));
		const transform = keep(cv.getPerspectiveTransform(from, to));
		const warped = keep(new cv.Mat());
		cv.warpPerspective(src, warped, transform, new cv.Size(488, 680));
		const out = document.createElement('canvas');
		cv.imshow(out, warped);
		return artHashesOfWarp(out);
	} finally { for (const mat of mats.reverse()) mat.delete(); }
}
