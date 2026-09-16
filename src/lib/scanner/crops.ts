/**
 * Locate the OCR windows (name band, collector strip) inside a warped card
 * from its intensity profiles instead of fixed percentages.
 *
 * The perspective warp is only as good as the detected quad: a loose quad
 * leaves background margin, a tight one cuts into the border, a grid-inferred
 * cell may be shifted by a few percent. Fixed windows tuned for one case miss
 * the text in the others. The black border, however, is always there: its
 * inner edge is where the frame starts, the name bar sits just below the top
 * inner edge and the collector line sits just inside the bottom border. So we
 * scan row/column mean intensities for the leading/trailing dark runs and
 * anchor the windows on those edges. White-bordered cards have no dark run
 * and fall back to the fixed windows.
 *
 * Pure functions over number arrays — the OpenCV `reduce` calls that produce
 * the profiles live in the scanner page. Unit-tested in crops.test.ts.
 */

export type CropWindows = {
	nameX: number;
	nameY: number;
	nameW: number;
	nameH: number;
	bottomX: number;
	bottomY: number;
	bottomW: number;
	bottomH: number;
	/** Which edges were found from the profiles; 'fixed' means the legacy windows. */
	source: 'profile' | 'fixed';
	edges: { top: number | null; bottom: number | null; left: number | null };
};

/**
 * End index (exclusive) of the dark run at the start of `values`: the first
 * index whose value is >= `darkMax`, if the run before it is at least `minLen`
 * long and ends within `maxScan`. Returns null otherwise.
 */
export function leadingDarkRunEnd(values: ArrayLike<number>, darkMax: number, minLen: number, maxScan: number): number | null {
	const limit = Math.min(values.length, maxScan);
	let i = 0;
	while (i < limit && values[i] < darkMax) i++;
	if (i < minLen || i >= limit) return null;
	return i;
}

/**
 * Start index of the dark run at the end of `values` (scanning backwards):
 * the first index (from the end) whose value is >= `darkMax`, plus one.
 * Same run-length / scan-depth rules as leadingDarkRunEnd. Null if none.
 */
export function trailingDarkRunStart(values: ArrayLike<number>, darkMax: number, minLen: number, maxScan: number): number | null {
	const n = values.length;
	const limit = Math.max(0, n - maxScan);
	let i = n - 1;
	while (i >= limit && values[i] < darkMax) i--;
	const runLen = n - 1 - i;
	if (runLen < minLen || i < limit) return null;
	return i + 1;
}

/**
 * Threshold below which a profile value counts as "dark", chosen per profile:
 * phone exposure and JPEG haze lift a black border to 80–120, and a dark card
 * frame is barely brighter than its border, so a fixed cut-off misses them.
 * 40% of the way from the 5th to the 95th percentile, clamped to 60–150.
 */
export function darkThreshold(values: ArrayLike<number>): number {
	const sorted = Array.from(values as ArrayLike<number>).sort((a, b) => a - b);
	if (sorted.length === 0) return 90;
	const lo = sorted[Math.floor(sorted.length * 0.05)];
	const hi = sorted[Math.floor(sorted.length * 0.95)];
	return Math.max(60, Math.min(150, lo + 0.4 * (hi - lo)));
}

/** Legacy fixed windows (percentages of the 488x680 warp). */
export function fixedCropWindows(W: number, H: number, synthetic: boolean): CropWindows {
	return {
		nameX: Math.floor(W * (synthetic ? 0.08 : 0.06)),
		nameY: Math.floor(H * (synthetic ? 0.03 : 0.055)),
		nameW: Math.floor(W * 0.68),
		nameH: Math.floor(H * 0.08),
		bottomX: 0,
		bottomY: Math.floor(H * 0.89),
		bottomW: Math.floor(W * 0.5),
		bottomH: Math.floor(H * 0.1),
		source: 'fixed',
		edges: { top: null, bottom: null, left: null }
	};
}

/**
 * Derive the windows from intensity profiles of the warped card.
 *
 * @param rowMeansCenter mean intensity per row over the central columns (x 15–85%)
 * @param rowMeansLeft   mean intensity per row over the left half (x 4–46%), where the collector text is
 * @param colMeans       mean intensity per column over the central rows (y 20–80%)
 */
export function cropWindowsFromProfiles(
	rowMeansCenter: ArrayLike<number>,
	rowMeansLeft: ArrayLike<number>,
	colMeans: ArrayLike<number>,
	W: number,
	H: number,
	synthetic: boolean
): CropWindows {
	const fixed = fixedCropWindows(W, H, synthetic);
	// A real border is at least ~1% of the card; scan at most 25% (top/left)
	// or 20% (bottom) in case the warp carries a lot of dark background.
	const top = leadingDarkRunEnd(rowMeansCenter, darkThreshold(rowMeansCenter), Math.round(H * 0.01), Math.round(H * 0.25));
	const bottom = trailingDarkRunStart(rowMeansLeft, darkThreshold(rowMeansLeft), Math.round(H * 0.01), Math.round(H * 0.2));
	const left = leadingDarkRunEnd(colMeans, darkThreshold(colMeans), Math.round(W * 0.01), Math.round(W * 0.25));
	if (top === null && bottom === null) return fixed;

	const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
	const win: CropWindows = { ...fixed, source: 'profile', edges: { top, bottom, left } };

	if (top !== null) {
		// Name bar starts ~1% below the inner edge of the top border; the band is
		// generous (8.5%) so slight misplacement still keeps the text inside.
		win.nameY = clamp(Math.round(top + H * 0.004), 0, H - 1);
		win.nameH = clamp(Math.round(H * 0.085), 1, H - win.nameY);
	}
	if (left !== null) {
		win.nameX = clamp(Math.round(left + W * 0.01), 0, W - 1);
		win.nameW = clamp(Math.round(W * 0.68), 1, W - win.nameX);
		win.bottomX = clamp(Math.round(left - W * 0.005), 0, W - 1);
		win.bottomW = clamp(Math.round(W * 0.5), 1, W - win.bottomX);
	}
	if (bottom !== null) {
		// Collector line is printed inside the bottom border, i.e. just below
		// the text box: start a little above the inner edge and cover the
		// border. On dark-framed cards the dark run already starts at the text
		// box, ~3% higher, so the window is 8% tall to still reach both lines.
		win.bottomY = clamp(Math.round(bottom - H * 0.015), 0, H - 1);
		win.bottomH = clamp(Math.round(H * 0.08), 1, H - win.bottomY);
	}
	return win;
}
