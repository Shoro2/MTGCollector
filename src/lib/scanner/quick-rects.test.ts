import { describe, expect, it } from 'vitest';
import { postFilterRects, preferFine, type QuickRect } from './quick-rects';

const box = (x: number, y: number, w: number, h: number, source: 'fine' | 'coarse' = 'fine'): QuickRect => ({
	corners: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
	rect: { x, y, width: w, height: h },
	area: w * h,
	source
});
const FRAME = { width: 720, height: 720 };

describe('postFilterRects', () => {
	it('drops the inner boxes of a card (art box, text box): their centre lies inside the card', () => {
		const card = box(180, 100, 360, 500);
		const art = box(205, 155, 310, 220);
		const text = box(205, 420, 310, 140);
		expect(postFilterRects([art, card, text], 0.25, FRAME)).toEqual([card]);
	});

	it('drops clutter far smaller than the largest card', () => {
		const card = box(100, 100, 300, 420);
		const keycap = box(500, 500, 60, 80);
		expect(postFilterRects([card, keycap], 0.25, FRAME)).toEqual([card]);
	});

	it('keeps cards lying next to each other', () => {
		const a = box(40, 150, 280, 390), b = box(380, 160, 280, 390);
		expect(postFilterRects([a, b], 0.25, FRAME)).toEqual([a, b]);
	});

	it('lets a fully visible card win over a background rectangle that reaches the frame edge and contains it', () => {
		// a mat print / table edge: reaches three frame edges and holds the card
		const background = box(125, 0, 595, 720, 'coarse');
		const card = box(250, 190, 270, 380, 'coarse');
		expect(postFilterRects([background, card], 0.25, FRAME)).toEqual([card]);
		// without frame dimensions the classic rule applies (outer wins)
		expect(postFilterRects([background, card], 0.25)).toEqual([background]);
	});

	it('still reports a lone card that is cut off at the frame edge (the viewfinder warns about it)', () => {
		const cut = box(0, 120, 300, 420);
		expect(postFilterRects([cut], 0.25, FRAME)).toEqual([cut]);
		// its art box stays suppressed: it touches no edge, but its size is that of an inner box of this card (0.85 x 0.45 of it)
		const art = box(20, 170, 255, 190);
		expect(postFilterRects([cut, art], 0.25, FRAME)).toEqual([cut]);
	});
});

describe('postFilterRects — blobs of several cards', () => {
	it('drops a blob of two touching cards (card-shaped again at 126x88 mm) and keeps its members', () => {
		const left = box(100, 200, 200, 280), right = box(304, 203, 200, 280);
		const blob = box(98, 198, 408, 288, 'coarse');
		expect(postFilterRects([blob, left, right], 0.25, FRAME)).toEqual([left, right]);
	});

	it('drops a 2x2 block of cards when two of its members were found on their own', () => {
		const a = box(100, 60, 200, 280), b = box(306, 62, 200, 280);
		const block = box(96, 56, 414, 570, 'coarse');
		expect(postFilterRects([block, a, b], 0.25, FRAME)).toEqual([a, b]);
	});

	it('drops a two-card blob with a single known member: the member spans the blob across', () => {
		const member = box(100, 200, 200, 280);
		const blob = box(98, 198, 408, 284, 'coarse');
		expect(postFilterRects([blob, member], 0.25, FRAME)).toEqual([member]);
	});

	it('keeps the outline of a black card found on its inner frame although its "name bar + art" block lies along three of its sides', () => {
		// phone session 2026-09-17 / synthetic scene mat-039: the outline is the inner frame (coarse), the fine pass sees the block
		const outline = box(172, 118, 356, 520, 'coarse');
		const nameAndArt = box(176, 121, 348, 290);
		expect(postFilterRects([outline, nameAndArt], 0.25, FRAME)).toEqual([outline]);
		// and the art box alone (card proportions, 0.93 of the inner frame's width) is no blob member either
		const art = box(186, 170, 330, 242);
		expect(postFilterRects([outline, art], 0.25, FRAME)).toEqual([outline]);
	});

	it('does not mistake the art box of a card for a blob member', () => {
		const card = box(180, 100, 360, 500, 'coarse');
		const art = box(207, 156, 306, 220);
		expect(postFilterRects([card, art], 0.25, FRAME)).toEqual([card]);
	});
});

describe('preferFine', () => {
	it('keeps the fine quad when both passes found the same card, and coarse quads of cards only the coarse pass saw', () => {
		const fine = box(100, 100, 300, 420, 'fine');
		const sameCoarse = box(104, 96, 296, 430, 'coarse');
		const otherCoarse = box(430, 120, 250, 350, 'coarse');
		expect(preferFine([fine, sameCoarse, otherCoarse])).toEqual([fine, otherCoarse]);
	});
});
