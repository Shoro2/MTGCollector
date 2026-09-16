/**
 * Spread geometry for multiple-card scans: oriented card dimensions and grid
 * inference as a *hypothesis*.
 *
 * The detection strategies find most cards of a flat-lay spread, but touching
 * or cut-off cards merge into one blob or come out partial. Two pure steps
 * recover them:
 *
 * 1. `filterByDimensions()` drops candidates whose *oriented* edge lengths
 *    (short and long side of the quad, not the axis-aligned bounding box) are
 *    off the median. A card tilted by a few degrees keeps its true edge
 *    lengths while its bounding box grows, so hand-laid spreads with mixed
 *    tilts no longer lose cards to the consistency check.
 * 2. `inferGrid()` links neighbouring cards into a lattice (integer row and
 *    column indices) and fits a mapping (grid index -> image position): affine by default,
 *    a full homography when enough cards are present and it clearly fits
 *    better (a phone photo taken at an angle foreshortens the far rows). The
 *    lattice is only accepted when the detected cards actually sit on it
 *    (small residuals, few off-grid cards) and the cards are not wider than
 *    their pitch. `emptyCells()` then enumerates the unoccupied cells, one
 *    row/column beyond the detected extent, as perspective-correct quads.
 *    Nothing is filled to an expected count: the caller still has to find
 *    evidence (texture) inside every cell before it becomes a card.
 *
 * Everything here is plain arithmetic on corner arrays so it runs in unit
 * tests without OpenCV.
 */

export type Point = [number, number];
export type Box = { x: number; y: number; width: number; height: number };

export type GridMapping = 'affine' | 'homography';

export type GridHypothesis = {
	/** Detected row/column count (before extrapolation). */
	rows: number;
	cols: number;
	mapping: GridMapping;
	/** How the cards were indexed: neighbour links, or 1-D clustering of the centres (sparse detections). */
	indexing: 'links' | 'clusters';
	/** Largest normalised residual (fraction of the local pitch) among the inlier cards. */
	residual: number;
	/** Cards that do not sit on the lattice (their nearest cell still counts as occupied). */
	offGrid: number;
	/** Occupied cells as "row,col" keys. */
	occupied: Set<string>;
	/** Half extents of a card in grid units along the column (c) and row (r) axis. */
	cellHalf: { c: number; r: number };
	/** Lattice mapping: fractional grid coordinates -> image pixels. */
	project: (c: number, r: number) => Point;
};

export type GridCell = { row: number; col: number; corners: Point[]; rect: Box };

export type InferGridOptions = {
	/** Also offer cells one row/column beyond the detected extent. Default true. */
	extrapolate?: boolean;
	/** A card whose centre is further than this fraction of the pitch from its cell is off-grid. Default 0.25. */
	maxResidual?: number;
	/** Reject the lattice when more than this fraction of the cards is off-grid. Default 0.2. */
	maxOffGridFrac?: number;
};

export function quadCentroid(q: Point[]): Point {
	let x = 0;
	let y = 0;
	for (const p of q) {
		x += p[0];
		y += p[1];
	}
	return [x / q.length, y / q.length];
}

export function quadBounds(q: Point[]): Box {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const [x, y] of q) {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Short and long edge of a quad, averaging opposite edges. Invariant to the
 * quad's rotation, unlike the bounding box.
 */
export function orientedDims(q: Point[]): { short: number; long: number } {
	if (q.length !== 4) {
		const b = quadBounds(q);
		return { short: Math.min(b.width, b.height), long: Math.max(b.width, b.height) };
	}
	const e = [0, 1, 2, 3].map((i) => {
		const a = q[i];
		const b = q[(i + 1) % 4];
		return Math.hypot(b[0] - a[0], b[1] - a[1]);
	});
	const a = (e[0] + e[2]) / 2;
	const b = (e[1] + e[3]) / 2;
	return { short: Math.min(a, b), long: Math.max(a, b) };
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}

/**
 * Keep the candidates whose oriented short and long edges are both within
 * `tolerance` of the median. Below `minItems` candidates a median is not
 * meaningful and everything is kept.
 */
export function filterByDimensions<T extends { corners: Point[] }>(
	items: T[],
	tolerance = 0.15,
	minItems = 4
): { kept: T[]; dropped: T[]; median: { short: number; long: number } | null } {
	if (items.length < minItems) return { kept: items, dropped: [], median: null };
	const dims = items.map((it) => orientedDims(it.corners));
	const med = { short: median(dims.map((d) => d.short)), long: median(dims.map((d) => d.long)) };
	const kept: T[] = [];
	const dropped: T[] = [];
	items.forEach((it, i) => {
		const d = dims[i];
		const ok =
			Math.abs(d.short - med.short) <= med.short * tolerance &&
			Math.abs(d.long - med.long) <= med.long * tolerance;
		(ok ? kept : dropped).push(it);
	});
	return { kept, dropped, median: med };
}

/** Gaussian elimination with partial pivoting; null when the system is singular. */
function solveLinear(a: number[][], b: number[]): number[] | null {
	const n = b.length;
	const m = a.map((row, i) => [...row, b[i]]);
	for (let col = 0; col < n; col++) {
		let pivot = col;
		for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
		if (Math.abs(m[pivot][col]) < 1e-12) return null;
		[m[col], m[pivot]] = [m[pivot], m[col]];
		for (let r = 0; r < n; r++) {
			if (r === col) continue;
			const f = m[r][col] / m[col][col];
			if (f === 0) continue;
			for (let k = col; k <= n; k++) m[r][k] -= f * m[col][k];
		}
	}
	return m.map((row, i) => row[n] / row[i]);
}

/** Least-squares fit of `basis(sample) -> target` (one scalar target); returns the coefficients. */
function leastSquares(rows: number[][], targets: number[]): number[] | null {
	const k = rows[0].length;
	const ata: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
	const atb: number[] = new Array(k).fill(0);
	rows.forEach((row, i) => {
		for (let p = 0; p < k; p++) {
			atb[p] += row[p] * targets[i];
			for (let q = 0; q < k; q++) ata[p][q] += row[p] * row[q];
		}
	});
	return solveLinear(ata, atb);
}

type Sample = { c: number; r: number; x: number; y: number };

function fitAffine(samples: Sample[]): ((c: number, r: number) => Point) | null {
	if (samples.length < 3) return null;
	const basis = samples.map((s) => [1, s.c, s.r]);
	const ax = leastSquares(basis, samples.map((s) => s.x));
	const ay = leastSquares(basis, samples.map((s) => s.y));
	if (!ax || !ay) return null;
	return (c, r) => [ax[0] + ax[1] * c + ax[2] * r, ay[0] + ay[1] * c + ay[2] * r];
}

/**
 * Least-squares homography from grid coordinates to (normalised) image
 * coordinates via the linearised DLT equations with h8 = 1.
 */
function fitHomography(samples: Sample[]): ((c: number, r: number) => Point) | null {
	if (samples.length < 5) return null;
	const rows: number[][] = [];
	const targets: number[] = [];
	for (const s of samples) {
		rows.push([s.c, s.r, 1, 0, 0, 0, -s.x * s.c, -s.x * s.r]);
		targets.push(s.x);
		rows.push([0, 0, 0, s.c, s.r, 1, -s.y * s.c, -s.y * s.r]);
		targets.push(s.y);
	}
	const h = leastSquares(rows, targets);
	if (!h) return null;
	return (c, r) => {
		const w = h[6] * c + h[7] * r + 1;
		return [(h[0] * c + h[1] * r + h[2]) / w, (h[3] * c + h[4] * r + h[5]) / w];
	};
}

function rms(samples: Sample[], project: (c: number, r: number) => Point): number {
	let sum = 0;
	for (const s of samples) {
		const [px, py] = project(s.c, s.r);
		sum += (px - s.x) ** 2 + (py - s.y) ** 2;
	}
	return Math.sqrt(sum / samples.length);
}

/** Local pitch (shorter of the column and row step) around a grid position. */
function localPitch(project: (c: number, r: number) => Point, c: number, r: number): number {
	const [x0, y0] = project(c, r);
	const [xc, yc] = project(c + 1, r);
	const [xr, yr] = project(c, r + 1);
	return Math.min(Math.hypot(xc - x0, yc - y0), Math.hypot(xr - x0, yr - y0));
}

/** 1-D clustering: sorted values closer than `threshold` share a group. Returns member indices per group, ascending. */
export function cluster1D(values: number[], threshold: number): number[][] {
	if (values.length === 0) return [];
	const sorted = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
	const groups: number[][] = [[sorted[0].i]];
	for (let i = 1; i < sorted.length; i++) {
		if (sorted[i].v - sorted[i - 1].v > threshold) groups.push([]);
		groups[groups.length - 1].push(sorted[i].i);
	}
	return groups;
}

type Indexing = { label: 'links' | 'clusters'; comp: number[]; col: number[]; row: number[]; main: number };

/**
 * Index the cards by clustering their centres into rows (by y) and columns
 * (by x). Blind to rotation and perspective, but it works for a sparse
 * detection where hardly any card has a direct neighbour to link to (four
 * cards of a 2 x 5 spread on four different rows) — the neighbour links
 * would split such a spread into components too small to fit.
 */
function clusterIndices(centres: Point[], bounds: Box[]): Indexing | null {
	const medW = median(bounds.map((b) => b.width));
	const medH = median(bounds.map((b) => b.height));
	const rowGroups = cluster1D(centres.map((p) => p[1]), medH * 0.4);
	const colGroups = cluster1D(centres.map((p) => p[0]), medW * 0.4);
	if (rowGroups.length < 2 || colGroups.length < 2) return null;
	const row = new Array<number>(centres.length).fill(0);
	const col = new Array<number>(centres.length).fill(0);
	rowGroups.forEach((g, ri) => g.forEach((i) => (row[i] = ri)));
	colGroups.forEach((g, ci) => g.forEach((i) => (col[i] = ci)));
	return { label: 'clusters', comp: centres.map(() => 0), col, row, main: 0 };
}

/**
 * Link every card to its nearest right and bottom neighbour and propagate
 * integer lattice indices along the links (breadth-first). Local links keep
 * the indexing valid under rotation and perspective, where clustering the
 * centres by x or y alone fans out and merges columns. A gap of one missing
 * cell is bridged by the step count; anything further apart ends up in a
 * separate component, which `inferGrid()` attaches through the fitted
 * mapping afterwards.
 */
function latticeIndices(centres: Point[], bounds: Box[]): Indexing {
	const n = centres.length;
	type Link = { from: number; to: number; dc: number; dr: number };
	const rightOf: Array<{ j: number; ratio: number } | null> = new Array(n).fill(null);
	const belowOf: Array<{ j: number; ratio: number } | null> = new Array(n).fill(null);
	for (let i = 0; i < n; i++) {
		const w = bounds[i].width;
		const h = bounds[i].height;
		let bestR = Infinity;
		let bestB = Infinity;
		for (let j = 0; j < n; j++) {
			if (j === i) continue;
			const dx = centres[j][0] - centres[i][0];
			const dy = centres[j][1] - centres[i][1];
			const d = Math.hypot(dx, dy);
			// A neighbour lies roughly along the axis: within half a card of the
			// line and within ~22 degrees of it, so a diagonal cell never links
			// (a missing cell below would otherwise make the diagonal the
			// nearest "below" candidate under perspective).
			if (dx > 0.5 * w && dx < 2.6 * w && Math.abs(dy) < Math.min(0.5 * h, 0.4 * dx) && d < bestR) {
				bestR = d;
				rightOf[i] = { j, ratio: dx / w };
			}
			if (dy > 0.5 * h && dy < 2.6 * h && Math.abs(dx) < Math.min(0.5 * w, 0.4 * dy) && d < bestB) {
				bestB = d;
				belowOf[i] = { j, ratio: dy / h };
			}
		}
	}
	// Pitch in units of the card size. The smallest plausible nearest-neighbour
	// distance is one pitch (cards cannot sit closer than that; below 0.8 the
	// link came from a partial detection). Every other link is a whole
	// multiple of it (a missing card in between), so the median of the
	// per-link pitch estimates stays right even when most rows have a gap.
	const pitchOf = (links: Array<{ j: number; ratio: number } | null>) => {
		const ratios = links.filter((l): l is { j: number; ratio: number } => !!l).map((l) => l.ratio);
		if (ratios.length === 0) return 1;
		const plausible = ratios.filter((r) => r >= 0.8);
		const seed = plausible.length ? Math.min(...plausible) : median(ratios);
		return median(ratios.map((r) => r / Math.max(1, Math.round(r / seed))));
	};
	const pitchC = pitchOf(rightOf);
	const pitchR = pitchOf(belowOf);
	const links: Link[] = [];
	rightOf.forEach((l, i) => {
		if (l) links.push({ from: i, to: l.j, dc: Math.max(1, Math.round(l.ratio / pitchC)), dr: 0 });
	});
	belowOf.forEach((l, i) => {
		if (l) links.push({ from: i, to: l.j, dc: 0, dr: Math.max(1, Math.round(l.ratio / pitchR)) });
	});
	const adjacency: Link[][] = Array.from({ length: n }, () => []);
	for (const l of links) {
		adjacency[l.from].push(l);
		adjacency[l.to].push({ from: l.to, to: l.from, dc: -l.dc, dr: -l.dr });
	}

	const comp = new Array<number>(n).fill(-1);
	const col = new Array<number>(n).fill(0);
	const row = new Array<number>(n).fill(0);
	const sizes: number[] = [];
	for (let s = 0; s < n; s++) {
		if (comp[s] !== -1) continue;
		const id = sizes.length;
		const queue = [s];
		comp[s] = id;
		let size = 0;
		while (queue.length) {
			const i = queue.shift()!;
			size++;
			for (const l of adjacency[i]) {
				if (comp[l.to] !== -1) continue; // first assignment wins; a conflicting link shows up as a residual later
				comp[l.to] = id;
				col[l.to] = col[i] + l.dc;
				row[l.to] = row[i] + l.dr;
				queue.push(l.to);
			}
		}
		sizes.push(size);
	}
	let main = 0;
	sizes.forEach((size, id) => {
		if (size > sizes[main]) main = id;
	});
	return { label: 'links', comp, col, row, main };
}

/**
 * Index the detected cards on a lattice and fit the mapping. Returns null
 * when the cards do not form a plausible grid (fewer than two rows or
 * columns, too many cards off the lattice, or cards wider than their pitch,
 * as in a brick-pattern layout).
 */
export function inferGrid(
	cards: Array<{ corners: Point[] }>,
	frame: { width: number; height: number },
	opts: InferGridOptions = {}
): GridHypothesis | null {
	const maxResidual = opts.maxResidual ?? 0.25;
	const maxOffGridFrac = opts.maxOffGridFrac ?? 0.2;
	if (cards.length < 3) return null;

	const centres = cards.map((c) => quadCentroid(c.corners));
	const bounds = cards.map((c) => quadBounds(c.corners));
	if (bounds.some((b) => !(b.width > 0) || !(b.height > 0))) return null;

	// Normalise pixel coordinates so the homography's normal equations stay
	// well conditioned (grid indices are small integers, pixels are hundreds).
	const scale = Math.max(frame.width, frame.height) || 1;

	const fit = (subset: Sample[]): { project: (c: number, r: number) => Point; mapping: GridMapping } | null => {
		const affine = fitAffine(subset);
		if (!affine) return null;
		let best = { project: affine, mapping: 'affine' as GridMapping };
		if (subset.length >= 6) {
			const homography = fitHomography(subset);
			if (homography && rms(subset, homography) < rms(subset, affine) * 0.7 && homographySane(homography, subset)) {
				best = { project: homography, mapping: 'homography' };
			}
		}
		return best;
	};
	const residualOf = (s: Sample, project: (c: number, r: number) => Point): number => {
		const [px, py] = project(s.c, s.r);
		const pitch = localPitch(project, s.c, s.r);
		return pitch > 0 ? Math.hypot(px - s.x, py - s.y) / pitch : Infinity;
	};

	type Solved = {
		indexing: Indexing['label'];
		model: { project: (c: number, r: number) => Point; mapping: GridMapping };
		samples: Sample[];
		inlier: boolean[];
		residuals: number[];
		rows: number;
		cols: number;
		residual: number;
	};

	/**
	 * Fit an indexing hypothesis: mapping from its main component, drop what
	 * does not sit on the lattice, then re-index every card to its nearest
	 * cell under the fitted mapping (a wrong link mis-indexes a card by a
	 * whole cell; the majority still pins the mapping down, and the other
	 * components attach the same way) and refit with the inliers.
	 */
	const solve = (indexing: Indexing): Solved | null => {
		const mainIdx = cards.map((_, i) => i).filter((i) => indexing.comp[i] === indexing.main);
		if (mainIdx.length < 3) return null;
		const samples: Sample[] = cards.map((_, i) => ({ c: indexing.col[i], r: indexing.row[i], x: centres[i][0] / scale, y: centres[i][1] / scale }));
		let model = fit(mainIdx.map((i) => samples[i]));
		if (!model) return null;
		let inlier = samples.map((s, i) => indexing.comp[i] === indexing.main && residualOf(s, model!.project) <= maxResidual);
		if (inlier.filter(Boolean).length < Math.max(3, mainIdx.length * 0.5)) return null;
		for (let round = 0; round < 3; round++) {
			const refit = fit(samples.filter((_, i) => inlier[i]));
			if (!refit) return null;
			model = refit;
			for (const s of samples) {
				const cell = nearestCellIndex(model.project, s);
				s.r = cell[0];
				s.c = cell[1];
			}
			const next = samples.map((s) => residualOf(s, model!.project) <= maxResidual);
			const changed = next.some((v, i) => v !== inlier[i]);
			inlier = next;
			if (inlier.filter(Boolean).length < 3) return null;
			if (!changed) break;
		}
		// Shift the indices so the detected lattice starts at (0, 0), then fit
		// once more in that frame (the mapping is expressed in shifted indices).
		const inlierIdx = samples.map((_, i) => i).filter((i) => inlier[i]);
		const minC = Math.min(...inlierIdx.map((i) => samples[i].c));
		const minR = Math.min(...inlierIdx.map((i) => samples[i].r));
		for (const s of samples) {
			s.c -= minC;
			s.r -= minR;
		}
		model = fit(inlierIdx.map((i) => samples[i]));
		if (!model) return null;
		const residuals = samples.map((s) => residualOf(s, model!.project));
		inlier = residuals.map((r) => r <= maxResidual);
		const inliers = samples.filter((_, i) => inlier[i]);
		if (inliers.length < 3 || inliers.length < cards.length * (1 - maxOffGridFrac)) return null;
		const rows = Math.max(...inliers.map((s) => s.r)) + 1;
		const cols = Math.max(...inliers.map((s) => s.c)) + 1;
		if (rows < 2 || cols < 2) return null;
		return {
			indexing: indexing.label,
			model,
			samples,
			inlier,
			residuals,
			rows,
			cols,
			residual: Math.max(0, ...residuals.filter((r) => r <= maxResidual))
		};
	};

	// Two ways to index the cards, validated the same way; the one that puts
	// more cards on its lattice wins (ties: the tighter fit).
	let solved: Solved | null = null;
	const clustered = clusterIndices(centres, bounds);
	for (const indexing of [latticeIndices(centres, bounds), ...(clustered ? [clustered] : [])]) {
		const candidate = solve(indexing);
		if (!candidate) continue;
		const n = candidate.inlier.filter(Boolean).length;
		const bestN = solved ? solved.inlier.filter(Boolean).length : -1;
		if (!solved || n > bestN || (n === bestN && candidate.residual < solved.residual)) solved = candidate;
	}
	if (!solved) return null;
	const { model, samples, inlier, rows, cols, residual, indexing } = solved;
	const offGrid = cards.length - inlier.filter(Boolean).length;

	const projectNorm = model.project;
	const project = (c: number, r: number): Point => {
		const [x, y] = projectNorm(c, r);
		return [x * scale, y * scale];
	};

	// Card extent in grid units: map the inlier quads' corners back into
	// lattice coordinates (numerical inverse of the mapping), so a sheared or
	// foreshortened card is measured along the lattice axes, not the image axes.
	const halfC: number[] = [];
	const halfR: number[] = [];
	samples.forEach((s, i) => {
		if (!inlier[i]) return;
		let minCc = Infinity;
		let maxCc = -Infinity;
		let minRr = Infinity;
		let maxRr = -Infinity;
		for (const [x, y] of cards[i].corners) {
			const g = invertProject(project, [x, y], [s.c, s.r]);
			if (!g) return;
			minCc = Math.min(minCc, g[0]);
			maxCc = Math.max(maxCc, g[0]);
			minRr = Math.min(minRr, g[1]);
			maxRr = Math.max(maxRr, g[1]);
		}
		halfC.push((maxCc - minCc) / 2);
		halfR.push((maxRr - minRr) / 2);
	});
	if (halfC.length === 0) return null;
	const cellHalf = { c: median(halfC), r: median(halfR) };
	// Cards wider than their pitch: the columns interleave (brick pattern) or
	// the linking split one column in two — not a lattice we can fill.
	if (cellHalf.c > 0.7 || cellHalf.r > 0.7) return null;
	cellHalf.c = Math.min(cellHalf.c, 0.5);
	cellHalf.r = Math.min(cellHalf.r, 0.5);

	const occupied = new Set<string>();
	samples.forEach((s, i) => {
		if (inlier[i]) {
			occupied.add(`${s.r},${s.c}`);
		} else {
			// Off-grid card: block the cell its centre falls into.
			const cell = nearestCellIndex(projectNorm, s);
			occupied.add(`${cell[0]},${cell[1]}`);
		}
	});

	return { rows, cols, mapping: model.mapping, indexing, residual, offGrid, occupied, cellHalf, project };
}

/**
 * Invert the lattice mapping numerically (Newton iterations on the local
 * Jacobian; the mapping is affine or a mild homography, so it converges in a
 * few steps). Returns fractional grid coordinates, or null when it diverges.
 */
function invertProject(project: (c: number, r: number) => Point, target: Point, guess: Point): Point | null {
	let c = guess[0];
	let r = guess[1];
	const eps = 1e-3;
	for (let iter = 0; iter < 8; iter++) {
		const [x, y] = project(c, r);
		const ex = target[0] - x;
		const ey = target[1] - y;
		if (Math.abs(ex) < 1e-7 && Math.abs(ey) < 1e-7) break;
		const [xc, yc] = project(c + eps, r);
		const [xr, yr] = project(c, r + eps);
		const j00 = (xc - x) / eps;
		const j10 = (yc - y) / eps;
		const j01 = (xr - x) / eps;
		const j11 = (yr - y) / eps;
		const det = j00 * j11 - j01 * j10;
		if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
		c += (j11 * ex - j01 * ey) / det;
		r += (-j10 * ex + j00 * ey) / det;
		if (!Number.isFinite(c) || !Number.isFinite(r)) return null;
	}
	return [c, r];
}

/** Nearest integer lattice cell (row, col) to a sample: invert the mapping and round, with a brute-force fallback. */
function nearestCellIndex(project: (c: number, r: number) => Point, s: Sample): [number, number] {
	const g = invertProject(project, [s.x, s.y], [s.c, s.r]);
	if (g && Math.abs(g[0]) < 50 && Math.abs(g[1]) < 50) return [Math.round(g[1]), Math.round(g[0])];
	let best: [number, number] = [0, 0];
	let bestD = Infinity;
	for (let r = -6; r <= 12; r++) {
		for (let c = -6; c <= 12; c++) {
			const [x, y] = project(c, r);
			const d = Math.hypot(x - s.x, y - s.y);
			if (d < bestD) {
				bestD = d;
				best = [r, c];
			}
		}
	}
	return best;
}

/** The perspective terms must keep every cell of the (extrapolated) grid in front of the camera with a sane scale range. */
function homographySane(project: (c: number, r: number) => Point, samples: Sample[]): boolean {
	let minC = Infinity;
	let maxC = -Infinity;
	let minR = Infinity;
	let maxR = -Infinity;
	for (const s of samples) {
		minC = Math.min(minC, s.c);
		maxC = Math.max(maxC, s.c);
		minR = Math.min(minR, s.r);
		maxR = Math.max(maxR, s.r);
	}
	let minPitch = Infinity;
	let maxPitch = 0;
	for (let r = minR - 1; r <= maxR + 1; r++) {
		for (let c = minC - 1; c <= maxC + 1; c++) {
			const p = localPitch(project, c, r);
			if (!Number.isFinite(p) || p <= 0) return false;
			minPitch = Math.min(minPitch, p);
			maxPitch = Math.max(maxPitch, p);
		}
	}
	return maxPitch / minPitch <= 3;
}

function overlapArea(a: Box, b: Box): number {
	const x1 = Math.max(a.x, b.x);
	const y1 = Math.max(a.y, b.y);
	const x2 = Math.min(a.x + a.width, b.x + b.width);
	const y2 = Math.min(a.y + a.height, b.y + b.height);
	if (x2 <= x1 || y2 <= y1) return 0;
	return (x2 - x1) * (y2 - y1);
}

/**
 * Unoccupied cells of the lattice, one row/column beyond the detected extent
 * when `extrapolate` is set, as perspective-correct quads (TL, TR, BR, BL in
 * grid orientation). Cells that leave the frame by more than `marginFrac` of
 * their own size or overlap a detected card by more than `maxOverlap` of
 * their area are left out. The caller decides per cell whether there is
 * evidence of a card inside it.
 */
export function emptyCells(
	h: GridHypothesis,
	cards: Array<{ corners: Point[] }>,
	frame: { width: number; height: number },
	opts: { extrapolate?: boolean; marginFrac?: number; maxOverlap?: number } = {}
): GridCell[] {
	const extrapolate = opts.extrapolate ?? true;
	const marginFrac = opts.marginFrac ?? 0.05;
	const maxOverlap = opts.maxOverlap ?? 0.3;
	const cardBounds = cards.map((c) => quadBounds(c.corners));
	const cells: GridCell[] = [];
	const r0 = extrapolate ? -1 : 0;
	const r1 = extrapolate ? h.rows : h.rows - 1;
	const c0 = extrapolate ? -1 : 0;
	const c1 = extrapolate ? h.cols : h.cols - 1;
	for (let r = r0; r <= r1; r++) {
		for (let c = c0; c <= c1; c++) {
			if (h.occupied.has(`${r},${c}`)) continue;
			const corners: Point[] = [
				h.project(c - h.cellHalf.c, r - h.cellHalf.r),
				h.project(c + h.cellHalf.c, r - h.cellHalf.r),
				h.project(c + h.cellHalf.c, r + h.cellHalf.r),
				h.project(c - h.cellHalf.c, r + h.cellHalf.r)
			];
			const rect = quadBounds(corners);
			if (!(rect.width > 0) || !(rect.height > 0)) continue;
			const mx = rect.width * marginFrac;
			const my = rect.height * marginFrac;
			const inside = corners.every(([x, y]) => x >= -mx && y >= -my && x <= frame.width + mx && y <= frame.height + my);
			if (!inside) continue;
			const cellArea = rect.width * rect.height;
			if (cardBounds.some((b) => overlapArea(rect, b) > cellArea * maxOverlap)) continue;
			cells.push({ row: r, col: c, corners, rect });
		}
	}
	return cells;
}
