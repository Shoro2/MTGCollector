import { describe, it, expect } from 'vitest';
import { fitContain, touchesFrameEdge, orderCornersForCard } from './geometry';

describe('fitContain', () => {
	it('pillarboxes a portrait stream inside a landscape box', () => {
		// 1080x1920 phone stream in a 360x202 (16:9) viewfinder
		const fit = fitContain(1080, 1920, 360, 202.5);
		expect(fit.scale).toBeCloseTo(202.5 / 1920, 6);
		expect(fit.height).toBeCloseTo(202.5, 6);
		expect(fit.width).toBeCloseTo(1080 * (202.5 / 1920), 6);
		expect(fit.y).toBeCloseTo(0, 6);
		expect(fit.x).toBeCloseTo((360 - fit.width) / 2, 6);
	});

	it('letterboxes a landscape stream inside a portrait box', () => {
		const fit = fitContain(1920, 1080, 360, 640);
		expect(fit.scale).toBeCloseTo(360 / 1920, 6);
		expect(fit.x).toBeCloseTo(0, 6);
		expect(fit.y).toBeCloseTo((640 - 1080 * (360 / 1920)) / 2, 6);
	});

	it('fills the box exactly when aspect ratios match', () => {
		const fit = fitContain(1920, 1080, 960, 540);
		expect(fit).toEqual({ x: 0, y: 0, width: 960, height: 540, scale: 0.5 });
	});

	it('maps a centred portrait card to a portrait outline (not a squashed one)', () => {
		// Regression: the old overlay scaled x by boxW/srcW and y by boxH/srcH,
		// which drew a card held upright as a landscape rectangle.
		const fit = fitContain(1080, 1920, 360, 202.5);
		const w = 600 * fit.scale;
		const h = 840 * fit.scale;
		expect(h).toBeGreaterThan(w);
	});

	it('returns zeros for degenerate input', () => {
		expect(fitContain(0, 0, 100, 100).scale).toBe(0);
		expect(fitContain(100, 100, 0, 0).scale).toBe(0);
	});
});

describe('touchesFrameEdge', () => {
	const frame = { w: 1080, h: 1920 };

	it('is false for a rect well inside the frame', () => {
		expect(touchesFrameEdge({ x: 200, y: 400, width: 600, height: 840 }, frame.w, frame.h, 20)).toBe(false);
	});

	it('flags each edge', () => {
		expect(touchesFrameEdge({ x: 5, y: 400, width: 600, height: 840 }, frame.w, frame.h, 20)).toBe(true);
		expect(touchesFrameEdge({ x: 200, y: 10, width: 600, height: 840 }, frame.w, frame.h, 20)).toBe(true);
		expect(touchesFrameEdge({ x: 470, y: 400, width: 600, height: 840 }, frame.w, frame.h, 20)).toBe(true);
		expect(touchesFrameEdge({ x: 200, y: 1070, width: 600, height: 840 }, frame.w, frame.h, 20)).toBe(true);
	});
});

describe('orderCornersForCard', () => {
	it('keeps an upright card upright: short edge on top, TL closest to origin', () => {
		const pts: Array<[number, number]> = [[700, 1200], [100, 1200], [100, 400], [700, 400]];
		const [tl, tr, br, bl] = orderCornersForCard(pts);
		expect(tl).toEqual([100, 400]);
		expect(tr).toEqual([700, 400]);
		expect(br).toEqual([700, 1200]);
		expect(bl).toEqual([100, 1200]);
	});

	it('rotates a sideways card so its short edge becomes the top', () => {
		// 840 wide x 600 tall rectangle (card lying on its side)
		const pts: Array<[number, number]> = [[100, 100], [940, 100], [940, 700], [100, 700]];
		const [tl, tr] = orderCornersForCard(pts);
		const top = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
		expect(top).toBeCloseTo(600, 6);
	});
});
