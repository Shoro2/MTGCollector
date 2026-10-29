import { describe, it, expect } from 'vitest';
import { borderStart, cardInSleeve, rewarpMatrix, SLEEVE } from './sleeve';

type Profiles = { gray: Record<Side, number[]>; sat: Record<Side, number[]> };
type Side = 'rowsTop' | 'rowsBottom' | 'colsLeft' | 'colsRight';

// Measured on warps of the owner's phone photos (2026-10-29, sleeved cards
// and unsleeved cards on the same white table): mean gray and HSV saturation
// of the outer 20 % on each side, in 0.5 % steps (40 values each), from the
// warp's edge for the top and left profiles and towards it for the others.
const MEASURED: Record<string, Profiles> = {
	// Deadly Rollick: dark blue sleeve band, then the card black border as a separate darker band
	deadlyRollick: {"gray":{"rowsTop":[181,181,181,181,181,181,166,77,43,41,40,40,58,55,40,37,35,35,40,54,57,62,111,111,103,99,93,92,93,102,90,51,47,83,92,89,87,84,81,79],"rowsBottom":[118,111,96,92,102,118,119,111,96,94,102,116,120,119,113,108,80,40,32,36,36,30,28,33,31,28,28,28,28,27,31,42,45,68,131,160,162,139,102,65],"colsLeft":[172,172,172,172,172,172,172,170,127,39,38,43,42,36,33,32,31,31,30,31,38,41,41,37,37,48,74,97,93,90,94,90,89,90,90,91,90,89,88,88],"colsRight":[82,81,83,85,88,91,91,89,88,88,87,80,51,45,47,47,44,41,35,33,34,34,34,34,32,31,34,33,37,45,38,42,59,138,173,172,172,172,172,172]},"sat":{"rowsTop":[42,42,41,41,40,39,33,59,92,99,103,100,56,34,50,56,57,55,50,45,45,50,46,48,49,49,50,50,50,44,44,46,39,21,23,27,29,35,41,44],"rowsBottom":[45,47,52,54,52,47,47,49,54,55,53,48,47,47,48,49,48,52,50,41,40,45,45,42,42,43,44,43,44,44,45,49,55,48,53,52,51,43,31,20],"colsLeft":[46,46,45,45,44,44,43,43,41,138,139,97,60,42,36,35,35,36,37,37,33,36,39,42,38,36,32,35,40,41,38,40,43,43,43,42,43,43,43,41],"colsRight":[42,41,40,41,41,40,42,43,43,44,44,47,54,50,44,47,48,49,50,47,41,37,37,39,45,46,53,80,107,101,60,39,48,47,42,43,44,44,44,45]}},
	// Brainstorm: light blue sleeve with glare, card black border visible as a thin dark line
	brainstorm: {"gray":{"rowsTop":[191,191,191,191,191,191,191,191,107,79,73,70,69,97,115,96,85,77,73,90,103,105,105,110,108,107,102,102,97,86,80,71,72,72,72,73,74,76,78,81],"rowsBottom":[121,135,144,137,125,118,116,130,135,136,141,131,90,88,89,89,88,81,81,78,80,84,84,74,55,48,48,47,46,43,45,55,58,53,111,170,184,185,185,185],"colsLeft":[185,185,185,185,185,185,186,188,161,57,55,65,71,79,76,73,69,66,63,66,77,88,91,91,91,91,92,92,92,98,105,92,76,97,96,95,96,96,93,90],"colsRight":[91,91,91,90,88,84,73,72,74,78,78,80,83,85,87,87,87,88,91,85,70,60,62,62,60,56,51,50,56,55,54,48,40,47,82,147,188,191,191,191]},"sat":{"rowsTop":[42,42,42,41,41,40,38,35,42,76,86,91,87,48,17,10,11,13,15,31,65,73,76,64,64,66,78,84,81,68,41,37,38,39,40,42,43,45,49,53],"rowsBottom":[26,21,20,18,20,23,23,24,23,22,19,28,85,105,99,90,90,104,111,112,114,115,114,92,31,14,14,14,15,17,25,48,64,59,42,42,40,40,40,40],"colsLeft":[43,43,43,42,42,42,42,41,33,127,131,88,39,18,14,12,11,12,15,25,64,90,99,99,99,98,98,98,96,82,76,63,56,35,36,40,42,43,43,42],"colsRight":[37,33,32,30,28,28,45,54,65,79,86,91,94,95,97,96,95,91,78,51,22,10,8,9,13,17,30,55,89,113,120,104,83,58,33,28,32,34,35,36]}},
	// Blinkmoth Infusion: quad on the card: black border at the warp edge, only a sliver of sleeve
	onCard: {"gray":{"rowsTop":[26,27,32,32,29,25,24,24,23,30,50,61,62,71,87,96,91,80,73,71,75,84,81,60,41,33,34,45,49,49,50,50,51,52,53,54,55,57,59,61],"rowsBottom":[96,96,96,96,96,95,91,84,83,86,92,94,95,95,94,94,94,94,93,93,84,67,46,41,45,51,52,53,57,59,58,55,40,10,0,0,0,0,0,0],"colsLeft":[24,23,25,25,24,24,23,23,22,28,51,53,35,30,37,52,58,60,59,58,56,56,58,57,58,58,58,57,58,58,56,60,61,60,61,64,73,67,63,66],"colsRight":[49,49,49,49,48,49,49,50,49,49,47,46,45,45,46,46,46,47,48,48,48,49,48,38,35,42,56,60,60,59,55,31,21,21,22,22,22,23,24,25]},"sat":{"rowsTop":[112,104,84,67,56,46,46,43,40,35,35,39,36,27,21,15,13,13,14,13,12,9,13,30,51,65,68,64,64,66,67,67,67,67,66,64,63,60,57,54],"rowsBottom":[29,29,29,28,28,28,29,33,34,32,29,29,28,28,27,26,24,24,23,23,21,27,40,56,66,69,69,68,69,71,72,75,58,12,0,0,0,0,0,0],"colsLeft":[53,44,40,40,41,41,42,41,45,37,37,46,49,51,53,42,46,47,46,45,44,43,42,43,44,43,43,44,42,41,41,38,38,38,36,32,27,27,31,28],"colsRight":[61,62,60,60,59,59,59,59,60,60,61,62,64,65,65,66,66,66,65,64,63,61,58,57,58,59,59,60,61,64,63,58,58,61,62,64,64,65,64,63]}},
	// Insidious Dreams: blue sleeve, card black border visible inside
	gridCell: {"gray":{"rowsTop":[188,188,188,189,189,189,189,189,190,190,189,181,136,63,48,48,54,64,57,52,49,48,47,49,53,54,56,61,73,77,76,59,51,53,51,48,48,49,49,49],"rowsBottom":[135,135,133,130,116,114,118,134,134,121,84,60,55,59,65,67,69,56,64,72,59,55,56,54,51,52,55,56,55,51,48,53,65,51,100,174,194,194,195,195],"colsLeft":[133,134,138,131,97,69,61,58,57,56,56,56,56,56,56,56,57,58,66,77,86,92,91,92,90,90,90,90,90,91,92,93,92,93,94,95,95,95,95,96],"colsRight":[53,52,51,52,52,51,49,47,51,64,73,78,63,58,64,87,111,138,163,182,189,189,189,189,189,189,189,189,188,188,188,188,188,188,188,188,187,187,187,187]},"sat":{"rowsTop":[41,40,39,39,39,38,37,37,36,35,34,35,55,102,125,128,108,54,24,22,20,21,22,22,21,22,23,24,26,26,24,25,24,23,22,24,23,24,25,26],"rowsBottom":[104,104,105,106,111,111,109,103,105,110,104,67,38,38,40,41,40,45,43,42,45,43,42,44,45,41,36,31,31,32,33,44,86,107,51,33,37,37,37,37],"colsLeft":[55,51,36,24,23,23,23,22,21,20,20,20,20,20,21,22,25,31,43,49,51,53,57,65,69,71,73,75,76,75,74,74,75,74,73,72,71,71,71,70],"colsRight":[34,33,31,28,26,25,25,25,32,36,52,71,78,71,57,43,38,37,38,38,37,38,38,38,39,39,39,40,40,40,40,40,40,40,41,40,40,40,40,41]}},
	// Fellwar Stone: no sleeve: white table margin, then the card black border
	unsleeved: {"gray":{"rowsTop":[151,151,151,153,118,52,21,18,18,19,31,41,39,39,41,46,56,50,52,36,30,29,36,44,46,46,46,46,45,45,46,46,46,45,43,42,41,40,39,37],"rowsBottom":[112,112,112,112,112,111,111,110,110,109,109,108,107,105,85,43,26,26,28,33,34,34,27,28,35,33,27,24,22,18,16,15,15,15,23,73,123,134,134,134],"colsLeft":[154,154,154,154,154,153,95,16,15,15,15,14,14,17,23,27,29,29,29,29,29,29,29,30,43,58,57,58,58,54,53,55,53,54,56,57,58,59,59,60],"colsRight":[63,66,67,68,68,68,70,70,71,73,72,69,58,55,56,40,31,31,31,31,31,31,31,31,36,31,17,15,15,15,15,16,22,40,50,53,60,80,116,135]},"sat":{"rowsTop":[52,51,51,50,59,73,82,88,91,91,86,89,93,93,91,87,79,81,78,87,93,89,78,69,67,65,65,65,65,64,64,64,64,65,66,66,66,67,69,70],"rowsBottom":[48,47,47,47,47,47,48,49,49,49,49,49,49,50,56,72,86,88,87,84,84,85,94,92,86,87,93,95,92,94,94,95,93,90,79,62,57,54,54,53],"colsLeft":[50,49,49,49,49,51,53,67,78,84,80,77,77,74,73,80,80,81,82,85,86,84,84,81,75,74,70,65,65,67,69,66,67,68,68,69,70,70,70,71],"colsRight":[65,63,62,62,63,62,62,63,63,65,66,69,75,80,80,79,85,87,88,88,89,89,88,87,87,89,83,88,89,89,88,86,73,57,64,65,64,62,55,50]}},
	// Supreme Verdict: no sleeve: white table, black border
	unsleeved2: {"gray":{"rowsTop":[165,165,165,165,149,91,39,18,18,18,19,24,51,76,82,90,95,101,114,118,115,99,65,35,28,29,29,29,29,30,30,30,31,31,32,34,35,36,37,41],"rowsBottom":[98,107,121,125,122,110,106,104,112,123,125,125,130,125,85,58,53,57,63,65,57,53,62,62,48,49,51,38,24,21,21,21,22,23,44,115,159,165,165,165],"colsLeft":[166,167,167,167,158,94,32,21,20,20,19,19,20,22,32,48,61,64,64,64,64,65,65,67,85,117,99,80,79,77,73,72,73,76,76,74,73,73,76,76],"colsRight":[87,87,89,87,88,88,88,90,91,92,89,66,69,68,65,69,69,68,68,67,67,66,66,85,51,20,20,20,20,20,21,24,36,52,62,67,77,114,159,169]},"sat":{"rowsTop":[49,49,49,49,55,64,70,87,98,99,95,83,85,108,116,117,112,103,89,87,92,104,111,73,59,63,63,62,61,60,60,59,57,56,53,51,51,50,49,48],"rowsBottom":[61,59,54,53,54,58,58,60,58,56,56,57,55,57,83,102,104,101,100,101,113,117,104,100,106,104,104,93,84,81,79,78,77,72,64,58,50,48,48,48],"colsLeft":[48,48,48,49,55,71,76,75,78,81,81,79,76,69,65,78,94,101,103,103,103,103,102,100,91,79,79,68,61,63,64,64,64,62,62,62,63,63,63,63],"colsRight":[63,63,63,63,63,64,64,64,65,65,67,76,77,80,95,99,100,102,103,104,105,106,105,101,91,65,65,67,70,69,64,55,46,57,69,74,73,62,49,45]}}
};

const W = 488, H = 680;
// Full-length profiles: the measured outer fifths, the card's middle in between.
function resample(outerA: number[], outerB: number[], middle: number, n: number): number[] {
	const bins = [...outerA, ...new Array(120).fill(middle), ...outerB];
	return Array.from({ length: n }, (_, i) => bins[Math.floor((i / n) * bins.length)]);
}
function correction(p: Profiles) {
	const rows = { gray: resample(p.gray.rowsTop, p.gray.rowsBottom, 100, H), sat: resample(p.sat.rowsTop, p.sat.rowsBottom, 40, H) };
	const cols = { gray: resample(p.gray.colsLeft, p.gray.colsRight, 100, W), sat: resample(p.sat.colsLeft, p.sat.colsRight, 40, W) };
	return cardInSleeve(rows, cols, W, H);
}

describe('borderStart', () => {
	it('finds the first dark, neutral run that is as long as a border', () => {
		const n = 200;
		const gray = new Array(n).fill(180), sat = new Array(n).fill(40);
		for (let i = 8; i < 12; i++) { gray[i] = 40; sat[i] = 120; } // blue sleeve band: dark, not neutral
		for (let i = 12; i < 20; i++) { gray[i] = 30; sat[i] = 60; } // the card's black border
		expect(borderStart(gray, sat, 90)).toBe(12 / n);
	});
	it('ignores a run shorter than a border and anything beyond the scan depth', () => {
		const n = 200;
		const gray = new Array(n).fill(180), sat = new Array(n).fill(40);
		gray[5] = gray[6] = 30; // a 1 % seam
		expect(borderStart(gray, sat, 90)).toBeNull();
		for (let i = 30; i < 40; i++) gray[i] = 30; // 15 %: deeper than SLEEVE.scan
		expect(borderStart(gray, sat, 90)).toBeNull();
	});
	it('counts a near-black border as neutral although its saturation is high', () => {
		const n = 200;
		const gray = new Array(n).fill(180), sat = new Array(n).fill(40);
		for (let i = 6; i < 12; i++) { gray[i] = 18; sat[i] = 100; } // 18 * 100 / 255 = 7
		expect(borderStart(gray, sat, 90)).toBe(6 / n);
	});
});

describe('cardInSleeve on measured profiles', () => {
	it('moves the warp onto a card in a blue sleeve', () => {
		const c = correction(MEASURED.deadlyRollick);
		expect(c).not.toBeNull();
		expect(c!.loose).toEqual(['top', 'left', 'right']);
		// The card's top edge was at 6.6 % of the warp; the new window puts it at the ordinary 3 %.
		expect((c!.edges.top! * H - c!.y) / c!.h).toBeCloseTo(SLEEVE.margin, 5);
		// The bottom has no band (the card rests on the sleeve's seam): its edge follows from the width.
		expect(c!.w / c!.h).toBeCloseTo(63 / 88, 5);
		expect(c!.y + c!.h * (1 - SLEEVE.margin)).toBeLessThan(H * (1 - c!.edges.bottom!));
		expect(c!.w).toBeLessThan(W);
		expect(c!.h).toBeLessThan(H);
	});
	it('finds the card under a light sleeve with glare on the border', () => {
		expect(correction(MEASURED.brainstorm)?.loose).toEqual(['top', 'left', 'right']);
	});
	it('leaves unsleeved cards, a quad already on the card and a grid cell alone', () => {
		expect(correction(MEASURED.unsleeved)).toBeNull();
		expect(correction(MEASURED.unsleeved2)).toBeNull();
		expect(correction(MEASURED.onCard)).toBeNull();
		expect(correction(MEASURED.gridCell)).toBeNull(); // only the top shows a band: a shifted cell, not a sleeve
	});
	it('needs a band on a horizontal and on a vertical side', () => {
		// A card photographed at an angle: the table shows left and right of the quad, not above or below it.
		const p = MEASURED.deadlyRollick;
		const tilted: Profiles = {
			gray: { ...p.gray, rowsTop: MEASURED.unsleeved.gray.rowsTop },
			sat: { ...p.sat, rowsTop: MEASURED.unsleeved.sat.rowsTop }
		};
		expect(correction(tilted)).toBeNull();
	});
});

describe('rewarpMatrix', () => {
	it('maps the window to the whole warp after the original transform', () => {
		const m = [2, 0, 10, 0, 2, 20, 0, 0, 1]; // source -> warp
		const r = rewarpMatrix(m, { x: 10, y: 20, w: 100, h: 200 }, 200, 400);
		const apply = (t: number[], x: number, y: number) => {
			const d = t[6] * x + t[7] * y + t[8];
			return [(t[0] * x + t[1] * y + t[2]) / d, (t[3] * x + t[4] * y + t[5]) / d];
		};
		// The source point that m sends to the window's top-left corner lands at (0, 0).
		expect(apply(r, 0, 0)).toEqual([0, 0]);
		expect(apply(r, 50, 100)).toEqual([200, 400]);
	});
});
