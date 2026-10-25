import { describe, it, expect } from 'vitest';
import { cardCutOffByFrame, fitContain, touchesFrameEdge, orderCornersForCard } from './geometry';

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

	it('untangles corners handed over in a crossed (bow-tie) order', () => {
		// Live capture on an iPhone, 2026-10-23: the tracked rectangle arrived as
		// TL(797,861) TR(299,597) BR(832,1419) BL(288,1440), and the warp of that
		// self-intersecting quad was unreadable.
		const crossed: Array<[number, number]> = [[797, 861], [299, 597], [832, 1419], [288, 1440]];
		const q = orderCornersForCard(crossed);
		// Every turn of the traversal has the same sign: a simple, convex polygon.
		const turns = q.map((p, i) => {
			const a = q[(i + 1) % 4], b = q[(i + 2) % 4];
			return Math.sign((a[0] - p[0]) * (b[1] - a[1]) - (a[1] - p[1]) * (b[0] - a[0]));
		});
		expect(new Set(turns).size).toBe(1);
		expect(new Set(q.map((p) => p.join(','))).size).toBe(4);
		// The same corners in polygon order give the same result.
		expect(orderCornersForCard([[299, 597], [797, 861], [832, 1419], [288, 1440]])).toEqual(q);
	});

	it('leaves a correctly ordered quad unchanged whatever corner it starts at', () => {
		const ring: Array<[number, number]> = [[100, 400], [700, 400], [700, 1200], [100, 1200]];
		for (let s = 0; s < 4; s++) {
			const rotated = [...ring.slice(s), ...ring.slice(0, s)];
			expect(orderCornersForCard(rotated)).toEqual(ring);
			expect(orderCornersForCard([...rotated].reverse())).toEqual(ring);
		}
	});
});

describe('cardCutOffByFrame', () => {
	it('flags the cut-off uploads of the 2026-10-23 iPhone session', () => {
		expect(cardCutOffByFrame([[-118, 68], [2213, -55], [2389, 3226], [58, 3349]], 3024, 4032)).toBe(true);
		expect(cardCutOffByFrame([[318, 1005], [2462, 743], [2860, 4024], [716, 4287]], 3024, 4032)).toBe(true);
	});

	it('leaves a card with space around it alone', () => {
		expect(cardCutOffByFrame([[333, 958], [2238, 958], [2238, 3457], [333, 3457]], 3024, 4032)).toBe(false);
	});
});
