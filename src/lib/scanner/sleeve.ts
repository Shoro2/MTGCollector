/**
 * Cards in sleeves: find the card inside a quad that the detection put on
 * the sleeve's outline.
 *
 * A sleeve is a few millimetres larger than its card, and the card slides to
 * the bottom of it, so the detected quad leaves a band of sleeve on the top,
 * left and right. The warp then holds the card several percent too small and
 * off centre, and every window that assumes the card's black border at the
 * warp's margin (the fixed name and collector windows, the art box) misses:
 * on the owner's photo of fifteen sleeved cards (2026-10-29) the name window
 * cut the names in half and the collector window held the sleeve, 4 of 15
 * cards were identified.
 *
 * The card's own black border is still there, inside the sleeve band, and it
 * is dark *and* neutral, while the coloured sleeve band is not neutral and
 * the table is not dark. So each side is scanned from the warp's edge inward
 * for the first dark, neutral run as long as a border; where it starts is the
 * card's edge. Unsleeved cards on the same table have that edge at 2.5–3.5 %
 * of the warp (the margin of expandedCardCorners), sleeved ones at 5.5–7.5 %
 * on the top and sides and at the usual place at the bottom.
 *
 * "Neutral" is the chroma proxy mean(gray) * mean(saturation) / 255: the
 * saturation of a near-black border is unreliable (the unsleeved borders
 * measured 70–115 with a slight colour cast, as saturated as the blue sleeve),
 * but at gray 15–40 the product stays at 4–9, where the sleeve band reaches
 * 14–28.
 *
 * Pure functions over profile arrays; the OpenCV reductions that make them
 * live in the scanner page. Unit-tested in sleeve.test.ts.
 */
import { darkThreshold } from './crops';

export const SLEEVE = {
	/** How far from each edge a border is looked for, as a fraction of the profile. */
	scan: 0.12,
	/** A border run is at least this long (a card's border is 2.4–4.3 % of the warp). */
	minRun: 0.015,
	/** Chroma proxy at or below which a dark position counts as the black border. */
	chromaMax: 11,
	/** A side whose card edge starts this far in or further holds a sleeve band. */
	looseFrom: 0.0475,
	/** ...and no further than this (beyond it the run is the artwork, not the border). */
	looseTo: 0.1,
	/** The side opposite a loose one must show margin before the card (the card is not cut off). */
	opposite: 0.015,
	/** Where the card's edge sits in an ordinary warp: the new window puts it there. */
	margin: 0.03,
	/** Sides that must show a sleeve band before the warp is moved onto the card. */
	minSides: 2,
	/** The card found must have card proportions (63 x 88 mm is 0.716). */
	aspectMin: 0.66,
	aspectMax: 0.77
} as const;

export type ProfilePair = { gray: ArrayLike<number>; sat: ArrayLike<number> };

export type SleeveCorrection = {
	/** The new warp window in warp pixels: the card plus the ordinary margin. */
	x: number;
	y: number;
	w: number;
	h: number;
	/** Where the card's border starts on each side, as a fraction from that edge (null: none found). */
	edges: { top: number | null; bottom: number | null; left: number | null; right: number | null };
	/** The sides that held a sleeve band. */
	loose: Array<'top' | 'bottom' | 'left' | 'right'>;
};

/**
 * Fraction from the start of `gray`/`sat` where the first dark, neutral run
 * of at least SLEEVE.minRun begins, within SLEEVE.scan. Null when none.
 */
export function borderStart(gray: ArrayLike<number>, sat: ArrayLike<number>, threshold: number): number | null {
	const n = gray.length;
	if (n === 0 || sat.length !== n) return null;
	const run = Math.max(1, Math.round(n * SLEEVE.minRun));
	const limit = Math.min(n - run, Math.round(n * SLEEVE.scan));
	const borderLike = (i: number) => gray[i] < threshold && (gray[i] * sat[i]) / 255 <= SLEEVE.chromaMax;
	for (let i = 0; i <= limit; i++) {
		if (!borderLike(i)) continue;
		let ok = true;
		for (let j = i + 1; j < i + run; j++) if (!borderLike(j)) { ok = false; break; }
		if (ok) return i / n;
	}
	return null;
}

const reversed = (v: ArrayLike<number>) => Array.from(v).reverse();
const outerThreshold = (gray: ArrayLike<number>) => {
	// The outer fifth on both ends: margin, sleeve, border and the frame next to them.
	const n = gray.length, k = Math.round(n * 0.2);
	const all = Array.from(gray);
	return darkThreshold([...all.slice(0, k), ...all.slice(n - k)]);
};

/**
 * The window to re-warp onto when the warp holds a card in a sleeve, or null
 * when it does not (or the evidence is not clear).
 *
 * @param rows gray and saturation means per row over the central columns (x 15–85 %), length H
 * @param cols gray and saturation means per column over the central rows (y 20–80 %), length W
 */
export function cardInSleeve(rows: ProfilePair, cols: ProfilePair, W: number, H: number): SleeveCorrection | null {
	if (rows.gray.length !== H || cols.gray.length !== W || H < 20 || W < 20) return null;
	const rowThr = outerThreshold(rows.gray), colThr = outerThreshold(cols.gray);
	const edges = {
		top: borderStart(rows.gray, rows.sat, rowThr),
		bottom: borderStart(reversed(rows.gray), reversed(rows.sat), rowThr),
		left: borderStart(cols.gray, cols.sat, colThr),
		right: borderStart(reversed(cols.gray), reversed(cols.sat), colThr)
	};
	const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' } as const;
	const isLoose = (e: number | null) => e !== null && e >= SLEEVE.looseFrom && e <= SLEEVE.looseTo;
	const loose = (['top', 'bottom', 'left', 'right'] as const).filter((s) => isLoose(edges[s]));
	if (loose.length < SLEEVE.minSides) return null;
	// A card shifted out of the warp on the other side is a misplaced quad, not a sleeve.
	for (const s of loose) {
		const o = edges[opposite[s]];
		if (o === null || o < SLEEVE.opposite) return null;
	}
	// The card's edge per side: where its border starts on a loose side; an
	// ordinary side keeps the place it has (or the usual margin if unknown).
	const edge = (s: 'top' | 'bottom' | 'left' | 'right') => {
		const e = edges[s];
		return e !== null && e < SLEEVE.looseFrom ? e : isLoose(e) ? (e as number) : SLEEVE.margin;
	};
	const left = edge('left') * W, right = (1 - edge('right')) * W;
	const top = edge('top') * H, bottom = (1 - edge('bottom')) * H;
	const cw = right - left, ch = bottom - top;
	if (cw <= 0 || ch <= 0) return null;
	const aspect = cw / ch;
	if (aspect < SLEEVE.aspectMin || aspect > SLEEVE.aspectMax) return null;
	// The new window shows the card with the ordinary margin around it.
	const w = cw / (1 - 2 * SLEEVE.margin), h = ch / (1 - 2 * SLEEVE.margin);
	return { x: left - w * SLEEVE.margin, y: top - h * SLEEVE.margin, w, h, edges, loose };
}

/**
 * The perspective matrix (row-major 3x3) that warps the source straight into
 * `win` of a W x H warp made with `m`: the window scaled to the whole warp,
 * applied after `m`.
 */
export function rewarpMatrix(m: ArrayLike<number>, win: { x: number; y: number; w: number; h: number }, W: number, H: number): number[] {
	const sx = W / win.w, sy = H / win.h;
	const a = [sx, 0, -win.x * sx, 0, sy, -win.y * sy, 0, 0, 1];
	const out = new Array(9).fill(0);
	for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
		let v = 0;
		for (let k = 0; k < 3; k++) v += a[r * 3 + k] * m[k * 3 + c];
		out[r * 3 + c] = v;
	}
	return out;
}
