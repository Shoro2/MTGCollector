import { describe, expect, it } from 'vitest';
import { isPlausibleCardQuad, luminanceSpread, polygonOrder, quadAngles, quadAspect, sampleQuadLuminance, type Pt } from './quad';

const rect = (x: number, y: number, w: number, h: number): Pt[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const rotate = (q: Pt[], deg: number, cx: number, cy: number): Pt[] => {
	const a = (deg * Math.PI) / 180;
	return q.map(([x, y]) => [cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)] as Pt);
};

describe('polygonOrder / quadAngles / quadAspect', () => {
	it('orders shuffled corners into a polygon and measures right angles', () => {
		const q = rect(100, 50, 358, 500);
		const shuffled: Pt[] = [q[2], q[0], q[3], q[1]];
		const ordered = polygonOrder(shuffled);
		for (const a of quadAngles(ordered)) expect(a).toBeCloseTo(90, 5);
		expect(quadAspect(shuffled)).toBeCloseTo(358 / 500, 5);
	});

	it('is rotation invariant (a bounding box is not)', () => {
		const q = rotate(rect(0, 0, 358, 500), 40, 179, 250);
		expect(quadAspect(q)).toBeCloseTo(0.716, 3);
	});
});

describe('isPlausibleCardQuad', () => {
	it('accepts upright, sideways, rotated and perspective-skewed cards', () => {
		expect(isPlausibleCardQuad(rect(100, 50, 358, 500))).toBe(true);
		expect(isPlausibleCardQuad(rect(50, 100, 500, 358))).toBe(true);
		expect(isPlausibleCardQuad(rotate(rect(0, 0, 358, 500), 33, 179, 250))).toBe(true);
		// photographed at an angle: the far edge is shorter
		expect(isPlausibleCardQuad([[120, 60], [430, 70], [470, 540], [80, 530]])).toBe(true);
	});

	it('rejects the degenerate quads a phone produced (2026-09-17 scan logs)', () => {
		// three corners nearly on one line: a triangle with a fourth point
		expect(isPlausibleCardQuad([[459, 990], [911, 988], [782, 0], [1024, 1079]])).toBe(false);
		expect(isPlausibleCardQuad([[169, 69], [158, 496], [22, 51], [656, 0]])).toBe(false);
		expect(isPlausibleCardQuad([[39, 131], [235, 67], [129, 402], [170, 184]])).toBe(false);
	});

	it('rejects shapes that are not card shaped', () => {
		expect(isPlausibleCardQuad(rect(0, 0, 400, 400))).toBe(false); // square (keycap)
		expect(isPlausibleCardQuad(rect(0, 0, 600, 200))).toBe(false); // banner
		expect(isPlausibleCardQuad([[0, 0], [200, 0], [420, 500], [0, 500]])).toBe(false); // trapezoid: one side less than 0.6 of its opposite
		expect(isPlausibleCardQuad([[0, 0], [400, 0], [760, 360], [360, 360]])).toBe(false); // parallelogram with 45 degree corners
		expect(isPlausibleCardQuad([[0, 0], [358, 0], [558, 500], [200, 500]])).toBe(true); // a 22 degree shear is still a card seen at an angle
		expect(isPlausibleCardQuad([[0, 0], [358, 0], [358, 500]] as Pt[])).toBe(false); // not four corners
	});

	it('takes the aspect window as an option (the text box of a card is 0.5)', () => {
		const box = rect(0, 0, 530, 265);
		expect(isPlausibleCardQuad(box)).toBe(false);
		expect(isPlausibleCardQuad(box, { minAspect: 0.4 })).toBe(true);
	});
});

describe('sampleQuadLuminance / luminanceSpread', () => {
	const W = 200, H = 280;
	const image = (f: (x: number, y: number) => number): Uint8ClampedArray => {
		const out = new Uint8ClampedArray(W * H * 4);
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const v = f(x, y), i = (y * W + x) * 4;
			out[i] = out[i + 1] = out[i + 2] = v;
			out[i + 3] = 255;
		}
		return out;
	};

	it('sees the wide luminance range of a card and the narrow one of a textured mat', () => {
		// a "card": black border, bright text box in the lower half, mid-tone art above
		const card = image((x, y) => (x < 12 || x > 187 || y < 12 || y > 267 ? 12 : y > 170 ? 225 : 110));
		// a woven mat: a fine dark texture
		const mat = image((x, y) => 45 + (((x >> 2) + (y >> 2)) % 2) * 28);
		const q = rect(0, 0, W - 1, H - 1);
		expect(luminanceSpread(sampleQuadLuminance(card, W, H, q))).toBeGreaterThan(100);
		expect(luminanceSpread(sampleQuadLuminance(mat, W, H, q))).toBeLessThan(40);
	});

	it('samples inside the quad only, in any corner order, and clamps to the frame', () => {
		const half = image((x) => (x < 100 ? 20 : 220));
		const left = sampleQuadLuminance(half, W, H, rect(5, 5, 85, 260));
		expect(Math.max(...left)).toBeLessThan(40);
		const shuffled: Pt[] = [[195, 270], [110, 10], [110, 270], [195, 10]];
		expect(Math.min(...sampleQuadLuminance(half, W, H, shuffled))).toBeGreaterThan(200);
		// a quad reaching beyond the frame still yields samples (clamped), never NaN
		const out = sampleQuadLuminance(half, W, H, rect(-50, -50, 400, 500));
		expect(out.every((v) => Number.isFinite(v))).toBe(true);
	});
});
