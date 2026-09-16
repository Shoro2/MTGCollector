import { describe, expect, it } from 'vitest';
import { BestFrameSelector, assessFrame, laplacianVariance, saturatedFraction, toGray } from './quality.js';

/** Synthetic RGBA frame: a grey field with a black/white checkerboard "card" whose edges can be blurred. */
function frame(width: number, height: number, card: { x: number; y: number; width: number; height: number }, opts: { blur?: number; glare?: number } = {}) {
	const rgba = new Uint8ClampedArray(width * height * 4);
	const value = (x: number, y: number): number => {
		if (x < card.x || y < card.y || x >= card.x + card.width || y >= card.y + card.height) return 128;
		const cell = 6;
		return ((Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 30 : 220);
	};
	const blur = opts.blur ?? 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let v = 0;
			let n = 0;
			for (let dy = -blur; dy <= blur; dy++) {
				for (let dx = -blur; dx <= blur; dx++) {
					v += value(Math.min(width - 1, Math.max(0, x + dx)), Math.min(height - 1, Math.max(0, y + dy)));
					n++;
				}
			}
			v = Math.round(v / n);
			const p = (y * width + x) * 4;
			rgba[p] = rgba[p + 1] = rgba[p + 2] = v;
			rgba[p + 3] = 255;
		}
	}
	// Glare: a white patch covering the given fraction of the card, top-left.
	if (opts.glare) {
		const side = Math.round(Math.sqrt(opts.glare * card.width * card.height));
		for (let y = card.y; y < card.y + side; y++) {
			for (let x = card.x; x < card.x + side; x++) {
				const p = (y * width + x) * 4;
				rgba[p] = rgba[p + 1] = rgba[p + 2] = 255;
			}
		}
	}
	return rgba;
}

const W = 160;
const H = 120;
const CARD = { x: 40, y: 20, width: 60, height: 84 };

describe('quality metrics', () => {
	it('toGray converts luma', () => {
		const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
		const g = toGray(rgba, 2, 1);
		expect(g[0]).toBe(255);
		expect(g[1]).toBe(0);
	});

	it('sharpness drops when the card is blurred', () => {
		const sharp = laplacianVariance(toGray(frame(W, H, CARD), W, H), W, H, CARD);
		const blurred = laplacianVariance(toGray(frame(W, H, CARD, { blur: 2 }), W, H), W, H, CARD);
		expect(sharp).toBeGreaterThan(0);
		expect(blurred).toBeLessThan(sharp * 0.5);
		// A flat region has no edges at all.
		expect(laplacianVariance(toGray(frame(W, H, CARD), W, H), W, H, { x: 0, y: 0, width: 30, height: 15 })).toBe(0);
	});

	it('glare is the blown-out fraction of the region', () => {
		expect(saturatedFraction(frame(W, H, CARD), W, H, CARD)).toBe(0);
		const g = saturatedFraction(frame(W, H, CARD, { glare: 0.1 }), W, H, CARD);
		expect(g).toBeGreaterThan(0.07);
		expect(g).toBeLessThan(0.13);
	});

	it('assessFrame discounts glare and ignores regions outside the frame', () => {
		const clean = assessFrame(frame(W, H, CARD), W, H, [CARD]);
		const glary = assessFrame(frame(W, H, CARD, { glare: 0.05 }), W, H, [CARD]);
		expect(clean.glare).toBe(0);
		expect(clean.score).toBeCloseTo(clean.sharpness, 6);
		expect(glary.glare).toBeGreaterThan(0.03);
		expect(glary.score).toBeLessThan(glary.sharpness);
		expect(assessFrame(frame(W, H, CARD), W, H, [{ x: 500, y: 500, width: 10, height: 10 }])).toEqual({ sharpness: 0, glare: 0, score: 0 });
		// No regions: the whole frame is measured.
		expect(assessFrame(frame(W, H, CARD), W, H, []).sharpness).toBeGreaterThan(0);
	});
});

describe('BestFrameSelector', () => {
	const q = (score: number, glare = 0) => ({ sharpness: score, glare, score });

	it('takes the first frame, then only clear improvements, and refreshes stale bests', () => {
		const sel = new BestFrameSelector({ windowMs: 1000, improveFactor: 1.15 });
		expect(sel.offer(q(100), 0)).toBe(true);
		expect(sel.offer(q(105), 100)).toBe(false); // within noise
		expect(sel.offer(q(130), 200)).toBe(true); // clear improvement
		expect(sel.offer(q(50), 300)).toBe(false);
		expect(sel.current(300)?.ageMs).toBe(100);
		expect(sel.offer(q(50), 1300)).toBe(true); // best older than the window
		sel.reset();
		expect(sel.current(1300)).toBeNull();
	});

	it('hints blur relative to the recent best and glare from the fraction', () => {
		const sel = new BestFrameSelector({ windowMs: 1000 });
		expect(sel.hint(q(100), 0)).toBe(''); // nothing to compare against yet
		sel.offer(q(100), 0);
		expect(sel.hint(q(40), 100)).toBe('blurry');
		expect(sel.hint(q(80), 100)).toBe('');
		expect(sel.hint(q(80, 0.05), 100)).toBe('glare');
		expect(sel.hint(q(40), 2000)).toBe(''); // the reference is stale
	});
});
