import { describe, it, expect } from 'vitest';
import { leadingDarkRunEnd, trailingDarkRunStart, cropWindowsFromProfiles, fixedCropWindows, darkThreshold } from './crops';

const W = 488, H = 680;

// Build a row profile: dark border rows, bright frame, dark bottom border.
function profile(topDarkRows: number, bottomDarkRows: number, bright = 200, dark = 30): number[] {
	const rows = new Array(H).fill(bright);
	for (let i = 0; i < topDarkRows; i++) rows[i] = dark;
	for (let i = H - bottomDarkRows; i < H; i++) rows[i] = dark;
	return rows;
}
const cols = (leftDark: number) => { const c = new Array(W).fill(180); for (let i = 0; i < leftDark; i++) c[i] = 25; return c; };

describe('dark run helpers', () => {
	it('finds the end of a leading dark run', () => {
		expect(leadingDarkRunEnd([10, 20, 30, 200, 210], 90, 2, 5)).toBe(3);
	});
	it('rejects runs shorter than minLen or longer than maxScan', () => {
		expect(leadingDarkRunEnd([10, 200, 200], 90, 2, 3)).toBeNull();
		expect(leadingDarkRunEnd([10, 10, 10, 10, 200], 90, 1, 3)).toBeNull();
		expect(leadingDarkRunEnd([200, 200], 90, 1, 2)).toBeNull();
	});
	it('finds the start of a trailing dark run', () => {
		expect(trailingDarkRunStart([200, 200, 30, 20], 90, 2, 4)).toBe(2);
		expect(trailingDarkRunStart([200, 200, 200], 90, 1, 3)).toBeNull();
	});
	it('bridges a short bright stretch inside the run only when asked to', () => {
		const v = [200, 200, 200, 20, 20, 120, 120, 20, 20, 20];
		expect(trailingDarkRunStart(v, 90, 2, 10)).toBe(7);
		expect(trailingDarkRunStart(v, 90, 2, 10, 2)).toBe(3);
		expect(trailingDarkRunStart(v, 90, 2, 10, 1)).toBe(7); // the stretch is two entries long
		expect(trailingDarkRunStart([200, 200, 120, 120, 120, 20, 20], 90, 2, 7, 2)).toBe(5); // the text box itself is never bridged
	});
});

describe('cropWindowsFromProfiles', () => {
	it('anchors the name band below the top border on a tight warp (border 0-3.4%)', () => {
		const win = cropWindowsFromProfiles(profile(23, 24), profile(23, 24), cols(17), W, H, false);
		expect(win.source).toBe('profile');
		expect(win.edges.top).toBe(23);
		expect(win.nameY).toBe(Math.round(23 + H * 0.004));
		// name text sits at 5.1-8.5% of the card => rows 35-58, inside the band
		expect(win.nameY).toBeLessThanOrEqual(35);
		expect(win.nameY + win.nameH).toBeGreaterThanOrEqual(58);
		// collector line at 96-99.4% => rows 653-676, inside the bottom window
		expect(win.bottomY).toBeLessThanOrEqual(653);
		expect(win.bottomY + win.bottomH).toBeGreaterThanOrEqual(676);
	});

	it('follows the border on a loose warp with 6% dark margin', () => {
		// card occupies rows 41..639 (6% margin top and bottom), border 3.4% of the card
		const cardH = 598, borderRows = Math.round(cardH * 0.034);
		const win = cropWindowsFromProfiles(profile(41 + borderRows, 41 + borderRows), profile(41 + borderRows, 41 + borderRows), cols(17), W, H, false);
		const nameTextTop = 41 + Math.round(cardH * 0.051), nameTextBottom = 41 + Math.round(cardH * 0.085);
		expect(win.nameY).toBeLessThanOrEqual(nameTextTop);
		expect(win.nameY + win.nameH).toBeGreaterThanOrEqual(nameTextBottom);
		const lineTop = 41 + Math.round(cardH * 0.96), lineBottom = 41 + Math.round(cardH * 0.994);
		expect(win.bottomY).toBeLessThanOrEqual(lineTop);
		expect(win.bottomY + win.bottomH).toBeGreaterThanOrEqual(lineBottom);
	});

	it('keeps both collector lines when the artist line is brighter than the border (M15 frame, phone 2026-09-18)', () => {
		// Row profile of a German War Horn (ORI 243/272) warped with ~3.5% margin: text box until
		// row 611, black border 612-679 with the number line at 615-623 (stays dark in the
		// left-half mean) and the artist line at 629-635 (above the threshold).
		const rows = profile(23, 68);
		for (let y = 629; y <= 635; y++) rows[y] = 110;
		const win = cropWindowsFromProfiles(rows, rows, cols(17), W, H, false);
		expect(win.edges.bottom).toBe(612);
		expect(win.bottomY).toBeLessThanOrEqual(615);
		expect(win.bottomY + win.bottomH).toBeGreaterThanOrEqual(636);
	});

	it('falls back to the fixed windows for white-bordered cards', () => {
		const win = cropWindowsFromProfiles(profile(0, 0), profile(0, 0), cols(0), W, H, false);
		expect(win.source).toBe('fixed');
		expect(win).toEqual(fixedCropWindows(W, H, false));
	});

	it('keeps windows inside the image', () => {
		const win = cropWindowsFromProfiles(profile(23, 6), profile(23, 6), cols(17), W, H, false);
		expect(win.bottomY + win.bottomH).toBeLessThanOrEqual(H);
		expect(win.nameX + win.nameW).toBeLessThanOrEqual(W);
	});
});

describe('darkThreshold', () => {
	it('adapts to hazy phone exposure where the border is grey rather than black', () => {
		// border rows at 110, frame/name bar at 210
		const rows = profile(23, 24, 210, 110);
		const t = darkThreshold(rows);
		expect(t).toBeGreaterThan(110);
		expect(t).toBeLessThan(210);
		const win = cropWindowsFromProfiles(rows, rows, cols(17), W, H, false);
		expect(win.edges.top).toBe(23);
	});

	it('stays within 60-150', () => {
		expect(darkThreshold(new Array(100).fill(255))).toBe(150);
		expect(darkThreshold(new Array(100).fill(0))).toBe(60);
	});
});
