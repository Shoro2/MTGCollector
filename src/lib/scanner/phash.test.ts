import { describe, expect, it } from 'vitest';
import { ART_BOX, HASH_SIZE, WARP_ART_MARGIN, artBoxOnWarp, dctHash, grayFromRgba, hammingDistance, resizeGray } from './phash';

/** A 32x32 gray image from a function of (x, y) in [0, 1). */
const image = (f: (x: number, y: number) => number): Float32Array => {
	const out = new Float32Array(HASH_SIZE * HASH_SIZE);
	for (let y = 0; y < HASH_SIZE; y++) for (let x = 0; x < HASH_SIZE; x++) out[y * HASH_SIZE + x] = f(x / HASH_SIZE, y / HASH_SIZE);
	return out;
};
/** Deterministic pseudo-noise in [-a, a]. */
const noise = (seed: number, a: number) => {
	let s = seed;
	return () => {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		return ((s / 0x7fffffff) * 2 - 1) * a;
	};
};

describe('hammingDistance', () => {
	it('counts differing bits of two hex hashes', () => {
		expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0);
		expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
		expect(hammingDistance('8000000000000001', '0000000000000000')).toBe(2);
	});
});

describe('dctHash', () => {
	it('is 64 bits as 16 lower-case hex characters and deterministic', () => {
		const h = dctHash(image((x, y) => 255 * Math.sin(x * 6) * Math.cos(y * 4)));
		expect(h).toMatch(/^[0-9a-f]{16}$/);
		expect(dctHash(image((x, y) => 255 * Math.sin(x * 6) * Math.cos(y * 4)))).toBe(h);
	});

	it('changes little under noise and brightness, a lot between different pictures', () => {
		const scene = (x: number, y: number) => 128 + 100 * Math.sin(x * 9) * Math.cos(y * 5) + 40 * Math.sin((x + y) * 13);
		const clean = dctHash(image(scene));
		const n = noise(7, 20);
		const noisy = dctHash(image((x, y) => scene(x, y) + n()));
		const darker = dctHash(image((x, y) => scene(x, y) * 0.6 + 10));
		// Uncorrelated per-pixel noise is harsher than JPEG + resampling; the scanner matches at <= 10 bits.
		expect(hammingDistance(clean, noisy)).toBeLessThanOrEqual(10);
		expect(hammingDistance(clean, darker)).toBeLessThanOrEqual(4);
		const other = dctHash(image((x, y) => 128 + 100 * Math.cos(x * 4) * Math.sin(y * 11) - 40 * Math.sin((x - y) * 7)));
		expect(hammingDistance(clean, other)).toBeGreaterThanOrEqual(20);
	});

	it('rejects the wrong input size', () => {
		expect(() => dctHash(new Float32Array(10))).toThrow(/32x32/);
	});
});

describe('grayFromRgba / resizeGray', () => {
	it('turns RGBA into luminance and averages blocks when shrinking', () => {
		const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255]);
		const gray = grayFromRgba(rgba, 2, 2);
		expect(Math.round(gray[0])).toBe(255);
		expect(Math.round(gray[1])).toBe(0);
		expect(gray[2]).toBeGreaterThan(gray[3]); // red is brighter than blue in luminance
		const small = resizeGray(gray, 2, 2, 1, 1);
		expect(small.length).toBe(1);
		expect(Math.round(small[0])).toBe(Math.round((gray[0] + gray[1] + gray[2] + gray[3]) / 4));
	});

	it('averages colour channels the same way for 3- and 4-channel buffers', () => {
		const rgb = new Uint8ClampedArray([255, 255, 255, 0, 0, 0]);
		const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
		expect(Array.from(grayFromRgba(rgb, 2, 1, 3))).toEqual(Array.from(grayFromRgba(rgba, 2, 1)));
	});

	it('defines the art box inside the card', () => {
		expect(ART_BOX.x + ART_BOX.w).toBeLessThanOrEqual(1);
		expect(ART_BOX.y + ART_BOX.h).toBeLessThan(0.6);
	});
});

describe('artBoxOnWarp', () => {
	it('shrinks the reference box towards the centre by the margin on every side', () => {
		const b = artBoxOnWarp(0.02);
		const k = 1 - 0.04;
		expect(b.x).toBeCloseTo(0.02 + ART_BOX.x * k, 6);
		expect(b.y).toBeCloseTo(0.02 + ART_BOX.y * k, 6);
		expect(b.w).toBeCloseTo(ART_BOX.w * k, 6);
		expect(b.h).toBeCloseTo(ART_BOX.h * k, 6);
		// the right and bottom edges move inwards by the same amount as the left and top
		expect(1 - (b.x + b.w)).toBeCloseTo(0.02 + (1 - ART_BOX.x - ART_BOX.w) * k, 6);
		expect(1 - (b.y + b.h)).toBeCloseTo(0.02 + (1 - ART_BOX.y - ART_BOX.h) * k, 6);
	});

	it('is the reference box at margin 0 and uses the measured margin by default', () => {
		expect(artBoxOnWarp(0)).toEqual({ x: ART_BOX.x, y: ART_BOX.y, w: ART_BOX.w, h: ART_BOX.h });
		expect(artBoxOnWarp()).toEqual(artBoxOnWarp(WARP_ART_MARGIN));
		expect(WARP_ART_MARGIN).toBeGreaterThan(0);
		expect(WARP_ART_MARGIN).toBeLessThan(0.05);
	});
});
