import { describe, expect, it } from 'vitest';
import { emptyCells, filterByDimensions, inferGrid, orientedDims, quadBounds, quadCentroid, type Point } from './grid.js';

/** Axis-aligned card quad (TL, TR, BR, BL) around a centre, optionally rotated. */
function cardQuad(cx: number, cy: number, w: number, h: number, angleDeg = 0): Point[] {
	const a = (angleDeg * Math.PI) / 180;
	const cos = Math.cos(a);
	const sin = Math.sin(a);
	const local: Point[] = [
		[-w / 2, -h / 2],
		[w / 2, -h / 2],
		[w / 2, h / 2],
		[-w / 2, h / 2]
	];
	return local.map(([x, y]) => [cx + x * cos - y * sin, cy + x * sin + y * cos]);
}

/** Cards of a lattice, skipping the given "row,col" cells. */
function lattice(rows: number, cols: number, pitchX: number, pitchY: number, w: number, h: number, origin: Point, skip: string[] = []) {
	const cards: Array<{ corners: Point[]; row: number; col: number }> = [];
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			if (skip.includes(`${r},${c}`)) continue;
			cards.push({ corners: cardQuad(origin[0] + c * pitchX, origin[1] + r * pitchY, w, h), row: r, col: c });
		}
	}
	return cards;
}

const PITCH_X = 110;
const PITCH_Y = 150;
const CARD_W = 100;
const CARD_H = 140;

describe('orientedDims', () => {
	it('returns the true edge lengths of a rotated card, not its bounding box', () => {
		const q = cardQuad(300, 300, 100, 140, 20);
		const d = orientedDims(q);
		expect(d.short).toBeCloseTo(100, 6);
		expect(d.long).toBeCloseTo(140, 6);
		const b = quadBounds(q);
		expect(b.width).toBeGreaterThan(120); // the bounding box grows with the tilt
	});
});

describe('filterByDimensions', () => {
	it('keeps tilted cards and drops merged blobs and partial cards', () => {
		const tilted = [-6, -3, 0, 2, 4, 6].map((angle, i) => ({ id: `card${i}`, corners: cardQuad(200 + i * 150, 300, CARD_W, CARD_H, angle) }));
		const merged = { id: 'merged', corners: cardQuad(500, 600, 2 * CARD_W, CARD_H) };
		const partial = { id: 'partial', corners: cardQuad(900, 600, CARD_W * 0.7, CARD_H) };
		const stackedMerge = { id: 'stacked', corners: cardQuad(1200, 600, CARD_W, 2 * CARD_H) };
		const { kept, dropped, median } = filterByDimensions([...tilted, merged, partial, stackedMerge]);
		expect(kept.map((k) => k.id)).toEqual(tilted.map((t) => t.id));
		expect(dropped.map((d) => d.id).sort()).toEqual(['merged', 'partial', 'stacked']);
		expect(median?.short).toBeCloseTo(CARD_W, 6);
		expect(median?.long).toBeCloseTo(CARD_H, 6);
	});

	it('keeps everything below four candidates', () => {
		const items = [cardQuad(0, 0, 100, 140), cardQuad(300, 0, 200, 140), cardQuad(600, 0, 50, 140)].map((corners) => ({ corners }));
		const { kept, dropped, median } = filterByDimensions(items);
		expect(kept).toHaveLength(3);
		expect(dropped).toHaveLength(0);
		expect(median).toBeNull();
	});
});

describe('inferGrid + emptyCells', () => {
	const frame = { width: 600, height: 660 };

	it('recovers the missing cells of a flat 3x4 lattice without extrapolating into the frame border', () => {
		const cards = lattice(3, 4, PITCH_X, PITCH_Y, CARD_W, CARD_H, [100, 110], ['1,2', '2,0']);
		const h = inferGrid(cards, frame);
		expect(h).not.toBeNull();
		expect(h!.rows).toBe(3);
		expect(h!.cols).toBe(4);
		expect(h!.mapping).toBe('affine');
		expect(h!.residual).toBeLessThan(0.01);
		expect(h!.offGrid).toBe(0);
		expect(h!.cellHalf.c).toBeCloseTo(CARD_W / PITCH_X / 2, 6);
		expect(h!.cellHalf.r).toBeCloseTo(CARD_H / PITCH_Y / 2, 6);

		const cells = emptyCells(h!, cards, frame, { extrapolate: false });
		expect(cells.map((c) => `${c.row},${c.col}`).sort()).toEqual(['1,2', '2,0']);
		const c12 = cells.find((c) => c.row === 1 && c.col === 2)!;
		const centre = quadCentroid(c12.corners);
		expect(centre[0]).toBeCloseTo(100 + 2 * PITCH_X, 6);
		expect(centre[1]).toBeCloseTo(110 + PITCH_Y, 6);
		expect(c12.rect.width).toBeCloseTo(CARD_W, 6);
		expect(c12.rect.height).toBeCloseTo(CARD_H, 6);

		// The frame ends 50 px left of the lattice and 40 px above it, so the
		// extrapolated row -1 / column -1 would leave the frame; the cells to
		// the right and below fit (600 x 660 leaves room for one more each).
		const extra = emptyCells(h!, cards, frame);
		const keys = extra.map((c) => `${c.row},${c.col}`);
		expect(keys).toContain('0,4');
		expect(keys).toContain('3,1');
		expect(keys.some((k) => k.startsWith('-1,') || k.endsWith(',-1'))).toBe(false);
	});

	it('fits a homography to a foreshortened spread and places the missing cell where the perspective puts it', () => {
		// Ideal lattice -> image: mild perspective (far rows smaller and closer together), slight shear.
		const H = [
			[1, 0.03, 60],
			[0, 1, 40],
			[0, 0.0006, 1]
		];
		const warp = ([x, y]: Point): Point => {
			const w = H[2][0] * x + H[2][1] * y + H[2][2];
			return [(H[0][0] * x + H[0][1] * y + H[0][2]) / w, (H[1][0] * x + H[1][1] * y + H[1][2]) / w];
		};
		const ideal = lattice(3, 5, PITCH_X, PITCH_Y, CARD_W, CARD_H, [80, 100], ['1,3']);
		const cards = ideal.map((c) => ({ corners: c.corners.map(warp) }));
		const big = { width: 1000, height: 800 };
		const h = inferGrid(cards, big);
		expect(h).not.toBeNull();
		expect(h!.mapping).toBe('homography');
		expect(h!.offGrid).toBe(0);
		expect(h!.residual).toBeLessThan(0.05);
		const cells = emptyCells(h!, cards, big, { extrapolate: false });
		expect(cells.map((c) => `${c.row},${c.col}`)).toEqual(['1,3']);
		// The synthetic cell's corners land where the missing card's corners would be projected.
		const idealCorners = cardQuad(80 + 3 * PITCH_X, 100 + PITCH_Y, CARD_W, CARD_H).map(warp);
		const centre = warp([80 + 3 * PITCH_X, 100 + PITCH_Y]);
		const right = warp([80 + 4 * PITCH_X, 100 + PITCH_Y]);
		const pitch = Math.hypot(right[0] - centre[0], right[1] - centre[1]);
		for (let k = 0; k < 4; k++) {
			const [x, y] = cells[0].corners[k];
			expect(Math.hypot(x - idealCorners[k][0], y - idealCorners[k][1])).toBeLessThan(pitch * 0.05);
		}
		const projected = h!.project(3, 1);
		expect(Math.hypot(projected[0] - centre[0], projected[1] - centre[1])).toBeLessThan(pitch * 0.03);
	});

	it('tolerates a stray card and blocks the cell it sits in', () => {
		const cards = lattice(3, 3, PITCH_X, PITCH_Y, CARD_W, CARD_H, [100, 110]);
		// Push one card 40% of a pitch sideways: off the lattice, but the rest still forms one.
		cards[4].corners = cardQuad(100 + PITCH_X + PITCH_X * 0.4, 110 + PITCH_Y, CARD_W, CARD_H);
		const h = inferGrid(cards, { width: 600, height: 600 });
		expect(h).not.toBeNull();
		expect(h!.offGrid).toBe(1);
		expect(h!.residual).toBeLessThan(0.05);
		expect(emptyCells(h!, cards, { width: 600, height: 600 }, { extrapolate: false })).toEqual([]);
	});

	it('rejects a layout where too many cards are off the lattice', () => {
		const cards = lattice(2, 3, PITCH_X, PITCH_Y, CARD_W, CARD_H, [100, 110]);
		cards[1].corners = cardQuad(100 + PITCH_X * 1.4, 110, CARD_W, CARD_H);
		cards[4].corners = cardQuad(100 + PITCH_X * 0.6, 110 + PITCH_Y, CARD_W, CARD_H);
		expect(inferGrid(cards, { width: 600, height: 600 })).toBeNull();
	});

	it('rejects a brick pattern (no card sits below another)', () => {
		const cards: Array<{ corners: Point[] }> = [];
		for (let c = 0; c < 3; c++) cards.push({ corners: cardQuad(100 + c * PITCH_X, 110, CARD_W, CARD_H) });
		for (let c = 0; c < 3; c++) cards.push({ corners: cardQuad(100 + c * PITCH_X + PITCH_X / 2, 110 + PITCH_Y, CARD_W, CARD_H) });
		expect(inferGrid(cards, { width: 600, height: 600 })).toBeNull();
	});

	it('rejects overlapping detections whose cards are wider than the column pitch', () => {
		const cards = lattice(2, 3, 60, PITCH_Y, CARD_W, CARD_H, [100, 110]);
		expect(inferGrid(cards, { width: 600, height: 600 })).toBeNull();
	});

	it('needs at least two rows and two columns', () => {
		const row = lattice(1, 4, PITCH_X, PITCH_Y, CARD_W, CARD_H, [100, 110]);
		expect(inferGrid(row, frame)).toBeNull();
	});

	it('skips a cell that is mostly covered by an oversized detection', () => {
		const cards = lattice(2, 2, PITCH_X, PITCH_Y, CARD_W, CARD_H, [100, 110], ['1,1']);
		// A blob spanning the missing cell and its left neighbour (as a merged pair would).
		cards.push({ corners: cardQuad(100 + PITCH_X * 0.5, 110 + PITCH_Y, 2 * CARD_W, CARD_H), row: 1, col: 0 });
		// The blob itself clusters into an extra column, so build the hypothesis from the three clean cards
		// and pass the blob only as an occupant.
		const clean = cards.slice(0, 3);
		const h = inferGrid(clean, frame)!;
		expect(h).not.toBeNull();
		const without = emptyCells(h, clean, frame, { extrapolate: false }).map((c) => `${c.row},${c.col}`);
		expect(without).toEqual(['1,1']);
		const withBlob = emptyCells(h, cards, frame, { extrapolate: false });
		expect(withBlob).toEqual([]);
	});
});
