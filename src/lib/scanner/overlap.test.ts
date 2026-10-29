import { describe, expect, it } from 'vitest';
import { CARD_ASPECT, detectOverlapRows, dominantAxis, supportMode, type GrayImage, type Pt, type Segment, type StripCard } from './overlap';

// A synthetic photo of fanned card rows, drawn directly as a grayscale buffer
// plus the straight segments a line detector would return for it (overlap-cv.ts
// is the OpenCV half and is exercised by the harness, not here). The cards carry
// the bands the row model looks for: black border, light name bar, type line
// and text box, a darker artwork and frame.

type SceneCard = { tl: Pt; right: Pt; down: Pt; h: number; w: number; art: number; row: number; index: number; visible: number };
type Scene = { width: number; height: number; bg: number; cards: SceneCard[] };

const add = (a: Pt, b: Pt, k = 1): Pt => [a[0] + b[0] * k, a[1] + b[1] * k];
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];

function makeScene(o: { width: number; height: number; rows: number; n: number; h: number; step: number; x0: number; y0: number; rowGap: number; tilt?: number; bg?: number }): Scene {
	const t = ((o.tilt ?? 0) * Math.PI) / 180;
	const right: Pt = [Math.cos(t), Math.sin(t)];
	const down: Pt = [-Math.sin(t), Math.cos(t)];
	const w = o.h * CARD_ASPECT;
	const cards: SceneCard[] = [];
	for (let r = 0; r < o.rows; r++) {
		const origin = add([o.x0, o.y0], down, r * o.h * (1 + o.rowGap));
		for (let i = 0; i < o.n; i++) {
			cards.push({ tl: add(origin, right, i * o.step * w), right, down, h: o.h, w, art: 60 + ((i * 37 + r * 53) % 100), row: r, index: i, visible: i === o.n - 1 ? 1 : o.step });
		}
	}
	return { width: o.width, height: o.height, bg: o.bg ?? 150, cards };
}

/** Luminance of a card at (u, v), its width and height fractions. */
function cardValue(c: SceneCard, u: number, v: number): number {
	if (u < 0.048 || u > 0.952 || v < 0.034 || v > 0.93) return 20; // black border (the bottom one carries the collector lines)
	if (v >= 0.045 && v <= 0.095 && u >= 0.055) return 215; // name bar
	if (v >= 0.11 && v <= 0.53 && u >= 0.08 && u <= 0.92) return c.art;
	if (v >= 0.54 && v <= 0.58 && u >= 0.055) return 210; // type line
	if (v >= 0.6 && v <= 0.9 && u >= 0.07 && u <= 0.93) return 225; // text box
	return 110; // frame
}

function sceneValue(s: Scene, p: Pt): number {
	// rows do not overlap; within a row the later card lies on top
	for (let k = s.cards.length - 1; k >= 0; k--) {
		const c = s.cards[k];
		const d: Pt = [p[0] - c.tl[0], p[1] - c.tl[1]];
		const u = dot(d, c.right) / c.w, v = dot(d, c.down) / c.h;
		if (u >= 0 && u <= 1 && v >= 0 && v <= 1) return cardValue(c, u, v);
	}
	return s.bg;
}

/** The photo turned by 0, 90, 180 or 270 degrees clockwise: maps a scene point to the photo. */
function turn(s: Scene, rot: 0 | 90 | 180 | 270): { width: number; height: number; map: (p: Pt) => Pt; unmap: (p: Pt) => Pt } {
	const { width: W, height: H } = s;
	if (rot === 90) return { width: H, height: W, map: ([x, y]) => [H - y, x], unmap: ([x, y]) => [y, H - x] };
	if (rot === 180) return { width: W, height: H, map: ([x, y]) => [W - x, H - y], unmap: ([x, y]) => [W - x, H - y] };
	if (rot === 270) return { width: H, height: W, map: ([x, y]) => [y, W - x], unmap: ([x, y]) => [W - y, x] };
	return { width: W, height: H, map: (p) => p, unmap: (p) => p };
}

function render(s: Scene, rot: 0 | 90 | 180 | 270 = 0): GrayImage {
	const t = turn(s, rot);
	const data = new Uint8Array(t.width * t.height);
	for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) data[y * t.width + x] = sceneValue(s, t.unmap([x + 0.5, y + 0.5]));
	return { data, width: t.width, height: t.height };
}

/**
 * The segments a line detector finds: every card's left edge (whole, it lies on
 * the card below) and the inner edge of its black border, the top and bottom of
 * every visible strip, the right edge and the artwork box of the last card.
 * `skip(card)` leaves a card's vertical edges out (an edge lost against a dark
 * artwork or background).
 */
function segments(s: Scene, rot: 0 | 90 | 180 | 270 = 0, skip: (c: SceneCard) => boolean = () => false): Segment[] {
	const { map } = turn(s, rot);
	const out: Segment[] = [];
	const seg = (a: Pt, b: Pt) => { const p = map(a), q = map(b); out.push([p[0], p[1], q[0], q[1]]); };
	const at = (c: SceneCard, u: number, v: number) => add(add(c.tl, c.right, u * c.w), c.down, v * c.h);
	for (const c of s.cards) {
		if (!skip(c)) {
			seg(at(c, 0, 0), at(c, 0, 1));
			seg(at(c, 0.048, 0.034), at(c, 0.048, 0.93));
		}
		const end = c.visible;
		seg(at(c, 0, 0), at(c, end, 0));
		seg(at(c, 0, 1), at(c, end, 1));
		if (c.visible === 1) {
			seg(at(c, 1, 0), at(c, 1, 1));
			seg(at(c, 0.08, 0.11), at(c, 0.08, 0.53));
			seg(at(c, 0.92, 0.11), at(c, 0.92, 0.53));
		}
	}
	return out;
}

/** Largest corner error of a detected card against the scene card, in card heights. */
function cornerError(found: StripCard, c: SceneCard, map: (p: Pt) => Pt): number {
	const truth = [c.tl, add(c.tl, c.right, c.w), add(add(c.tl, c.right, c.w), c.down, c.h), add(c.tl, c.down, c.h)].map(map);
	return Math.max(...found.corners.map((p, k) => Math.hypot(p[0] - truth[k][0], p[1] - truth[k][1]))) / c.h;
}

const twoRows = () => makeScene({ width: 1100, height: 800, rows: 2, n: 10, h: 300, step: 0.33, x0: 70, y0: 60, rowGap: 0.2, tilt: 2 });

function expectScene(layout: ReturnType<typeof detectOverlapRows>, s: Scene, rot: 0 | 90 | 180 | 270) {
	expect(layout).not.toBeNull();
	const { map } = turn(s, rot);
	expect(layout!.rows).toBe(2);
	expect(layout!.cards).toHaveLength(s.cards.length);
	for (const c of s.cards) {
		const found = layout!.cards.find((f) => f.row === c.row && f.index === c.index)!;
		expect(found, `row ${c.row} #${c.index}`).toBeDefined();
		expect(cornerError(found, c, map), `row ${c.row} #${c.index}`).toBeLessThan(0.04);
		expect(found.visible).toBeCloseTo(c.visible, 1);
		expect(found.full).toBe(c.visible === 1);
	}
}

describe('detectOverlapRows', () => {
	it('finds two upright rows with every card, its corners and its visible strip', () => {
		const s = twoRows();
		const layout = detectOverlapRows(segments(s), s.width, s.height, render(s));
		expectScene(layout, s, 0);
		expect(layout!.rotation).toBeCloseTo(2, 0);
		// the row model's estimate from the teeth (real teeth stop a few per cent short at the borders);
		// the corners above come from the band fit of every card
		expect(layout!.cardHeight / 300).toBeGreaterThan(0.95);
		expect(layout!.cardHeight / 300).toBeLessThan(1.1);
		// the strip of a covered card ends at the next card's left edge
		const first = layout!.cards.find((c) => c.row === 0 && c.index === 0)!;
		const next = layout!.cards.find((c) => c.row === 0 && c.index === 1)!;
		expect(Math.hypot(first.strip[1][0] - next.corners[0][0], first.strip[1][1] - next.corners[0][1])).toBeLessThan(0.03 * 300);
	});

	it.each([90, 180, 270] as const)('reads a photo turned by %i degrees with the card tops where they are', (rot) => {
		const s = twoRows();
		const t = turn(s, rot);
		const layout = detectOverlapRows(segments(s, rot), t.width, t.height, render(s, rot));
		expectScene(layout, s, rot);
		expect(((layout!.rotation - rot - 2 + 540) % 360) - 180).toBeCloseTo(0, 0);
	});

	it('inserts a left edge the line detector lost when the border notches show it', () => {
		const s = twoRows();
		const lost = (c: SceneCard) => c.row === 0 && c.index === 4;
		const layout = detectOverlapRows(segments(s, 0, lost), s.width, s.height, render(s));
		expectScene(layout, s, 0);
		expect(layout!.cards.find((c) => c.row === 0 && c.index === 4)!.edge).toBe('inserted');
		expect(layout!.cards.filter((c) => c.edge !== 'detected')).toHaveLength(1);
	});

	it('adds the first card of a row whose left edge vanished against a black background', () => {
		const s = makeScene({ width: 1100, height: 800, rows: 2, n: 10, h: 300, step: 0.33, x0: 70, y0: 60, rowGap: 0.2, tilt: -1.5, bg: 20 });
		const layout = detectOverlapRows(segments(s, 0, (c) => c.index === 0), s.width, s.height, render(s));
		expectScene(layout, s, 0);
		for (const row of [0, 1]) expect(layout!.cards.find((c) => c.row === row && c.index === 0)!.edge).toBe('extended');
	});

	it('finds nothing in a photo of separate cards', () => {
		const s = makeScene({ width: 1100, height: 800, rows: 1, n: 1, h: 300, step: 1, x0: 400, y0: 200, rowGap: 0 });
		expect(detectOverlapRows(segments(s), s.width, s.height, render(s))).toBeNull();
		expect(detectOverlapRows([], 1100, 800)).toBeNull();
	});
});

describe('dominantAxis', () => {
	it('returns the shared direction of two perpendicular edge families', () => {
		const t = (12 * Math.PI) / 180;
		const segs: Segment[] = [];
		for (let k = 0; k < 10; k++) {
			segs.push([100 + 30 * k, 100, 100 + 30 * k + 200 * Math.cos(t), 100 + 200 * Math.sin(t)]);
			segs.push([100, 100 + 30 * k, 100 - 200 * Math.sin(t), 100 + 30 * k + 200 * Math.cos(t)]);
		}
		expect(dominantAxis(segs)).toBeCloseTo(12, 0);
		expect(dominantAxis([])).toBe(0);
	});
});

describe('supportMode', () => {
	it('prefers the long, well-supported value over short noise', () => {
		expect(supportMode([300, 305, 298, 302, 80, 85, 82, 90, 88])).toBeGreaterThan(290);
	});
});
