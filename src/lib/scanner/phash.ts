/**
 * Perceptual hash of a card's art region (pHash: 32x32 gray -> 2-D DCT -> the
 * 8x8 low-frequency block without the DC term -> median threshold -> 64
 * bits). Pure: the server job feeds it pixels decoded by sharp, the scanner
 * feeds it pixels from a canvas, and both must produce the same bits for the
 * same artwork — which is why the art box and the resampling live here too.
 */

/** Side length of the gray block the hash is computed from. */
export const HASH_SIZE = 32;
/** Low-frequency block taken from the DCT (8x8 - DC = 63 bits, padded to 64 with the DC comparison dropped). */
const LOW = 8;

/**
 * Art region of a card as fractions of its width and height. A fixed box
 * for every frame: what matters is that the reference hash and the scan hash
 * cut the same region, not that the region is exactly the art on every
 * frame — showcase and borderless cards simply contribute whatever sits in
 * the box on both sides.
 */
export const ART_BOX = { x: 0.08, y: 0.115, w: 0.84, h: 0.415 } as const;

/**
 * The scanner's warp is not the card image: the detected quad is expanded by
 * 5% before the perspective transform, so the warp keeps ~3.45% of background
 * on every side, and the quad itself often sits a little inside the card's
 * edge. The art box on a warp therefore shrinks towards the centre by this
 * fraction of the warp. Measured on 102 warped cards of the eight development
 * photos against the reference hashes (`art-box-experiment.mjs`): 0 → mean
 * 12.3 bits, 51 cards within 10; 0.02 → 9.2 bits, 78 within 10; 0.0345 (the
 * geometric value) → 9.8 bits, 70 within 10.
 */
export const WARP_ART_MARGIN = 0.02;

/** ART_BOX shrunk towards the centre by `margin` on every side (fractions of the warp). */
export function artBoxOnWarp(margin: number = WARP_ART_MARGIN): { x: number; y: number; w: number; h: number } {
	const k = 1 - 2 * margin;
	return { x: margin + ART_BOX.x * k, y: margin + ART_BOX.y * k, w: ART_BOX.w * k, h: ART_BOX.h * k };
}

/** cos((2i + 1) u pi / 2N) for the separable DCT-II, computed once. */
const COS: Float64Array = (() => {
	const t = new Float64Array(HASH_SIZE * HASH_SIZE);
	for (let u = 0; u < HASH_SIZE; u++) for (let i = 0; i < HASH_SIZE; i++) t[u * HASH_SIZE + i] = Math.cos(((2 * i + 1) * u * Math.PI) / (2 * HASH_SIZE));
	return t;
})();

/** 64-bit pHash of a 32x32 gray block (row-major, values 0..255) as 16 lower-case hex characters. */
export function dctHash(gray: ArrayLike<number>): string {
	const n = HASH_SIZE;
	if (gray.length !== n * n) throw new Error(`dctHash expects a 32x32 gray block, got ${gray.length} values`);
	// Separable DCT: rows first (only the first LOW frequencies are needed), then columns.
	const rows = new Float64Array(n * LOW);
	for (let y = 0; y < n; y++) {
		for (let u = 0; u < LOW; u++) {
			let s = 0;
			for (let x = 0; x < n; x++) s += gray[y * n + x] * COS[u * n + x];
			rows[y * LOW + u] = s;
		}
	}
	const coeff = new Float64Array(LOW * LOW);
	for (let v = 0; v < LOW; v++) {
		for (let u = 0; u < LOW; u++) {
			let s = 0;
			for (let y = 0; y < n; y++) s += rows[y * LOW + u] * COS[v * n + y];
			coeff[v * LOW + u] = s;
		}
	}
	// Median of the 63 AC coefficients; the DC term (overall brightness) is excluded.
	const ac = Array.from(coeff.subarray(1)).sort((a, b) => a - b);
	const median = ac[Math.floor(ac.length / 2)];
	let hi = 0;
	let lo = 0;
	for (let k = 1; k < LOW * LOW; k++) {
		const bit = coeff[k] > median ? 1 : 0;
		if (k < 32) hi = (hi << 1) | bit;
		else lo = (lo << 1) | bit;
	}
	// k runs 1..63: 31 bits in `hi`, 32 in `lo`; pad `hi` to 32 bits with a leading 0.
	return (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
}

/** Number of differing bits between two 16-hex-character hashes. */
export function hammingDistance(a: string, b: string): number {
	let d = 0;
	for (let i = 0; i < 16; i += 8) {
		let x = (parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)) >>> 0;
		while (x) {
			x &= x - 1;
			d++;
		}
	}
	return d;
}

/** Rec. 601 luminance of an RGB(A) buffer (canvas ImageData, or a raw decode with 3 or 4 channels). */
export function grayFromRgba(data: ArrayLike<number>, width: number, height: number, channels = 4): Float32Array {
	const out = new Float32Array(width * height);
	for (let i = 0, p = 0; i < out.length; i++, p += channels) out[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
	return out;
}

/**
 * The whole client/server pipeline after the art box has been cut: luminance
 * at the source resolution, box-filter resize to HASH_SIZE, DCT hash. Both
 * sides call exactly this so a reference hash and a scan hash differ only by
 * what the camera did to the picture, never by the resampling.
 */
export function hashArtPixels(data: ArrayLike<number>, width: number, height: number, channels = 4): string {
	return dctHash(resizeGray(grayFromRgba(data, width, height, channels), width, height, HASH_SIZE, HASH_SIZE));
}

/** Area-averaging downscale of a gray image (box filter), the same on server and client. */
export function resizeGray(src: ArrayLike<number>, srcW: number, srcH: number, dstW: number, dstH: number): Float32Array {
	const out = new Float32Array(dstW * dstH);
	for (let y = 0; y < dstH; y++) {
		const y0 = Math.floor((y * srcH) / dstH);
		const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * srcH) / dstH));
		for (let x = 0; x < dstW; x++) {
			const x0 = Math.floor((x * srcW) / dstW);
			const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * srcW) / dstW));
			let s = 0;
			let n = 0;
			for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
				s += src[yy * srcW + xx];
				n++;
			}
			out[y * dstW + x] = s / n;
		}
	}
	return out;
}
