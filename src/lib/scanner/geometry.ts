/** Load an image file into an HTMLImageElement that's ready to draw. */
export function loadImage(file: File): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = reject;
		img.src = URL.createObjectURL(file);
	});
}

/**
 * Order the four corners of a detected card rectangle into
 * [top-left, top-right, bottom-right, bottom-left] — the order expected
 * by the perspective-transform destination matrix.
 *
 * The naive sum/diff approach fails for cards tilted ~25° or more in the
 * image plane: the corner with the smallest x+y is no longer necessarily
 * the "top-left" of the card, which causes the perspective transform to
 * output the card rotated 90°. This implementation handles arbitrary
 * rotation by:
 *
 * 1. Ensuring a consistent clockwise traversal.
 * 2. Treating the pair of edges longer than their neighbours as the
 *    card's long sides, and picking the short edge to serve as the
 *    "top" of the warped output.
 * 3. Breaking ties by picking whichever valid starting index puts the
 *    top-left as the corner closest to the image top-left corner.
 */
export function orderCornersForCard(pts: Array<[number, number]>): Array<[number, number]> {
	if (pts.length !== 4) return pts;

	// Step 1: enforce clockwise traversal (image coords: y increases downward,
	// so positive signed area == clockwise).
	const ordered = [...pts];
	let area = 0;
	for (let i = 0; i < 4; i++) {
		const j = (i + 1) % 4;
		area += ordered[i][0] * ordered[j][1] - ordered[j][0] * ordered[i][1];
	}
	if (area < 0) ordered.reverse();

	// Step 2: edge lengths in traversal order. edges[i] = |ordered[i] -> ordered[(i+1)%4]|.
	const edges = [0, 1, 2, 3].map((i) => {
		const a = ordered[i];
		const b = ordered[(i + 1) % 4];
		return Math.hypot(b[0] - a[0], b[1] - a[1]);
	});

	// Step 3: find candidate starting indices s where edges[s] is short and
	// edges[(s+1)%4] is long. For a rectangle there are always two such
	// candidates — they correspond to the two "portrait" orientations that
	// are 180° apart. We pick the one whose starting corner is closest to
	// the image's top-left.
	const candidates: number[] = [];
	for (let s = 0; s < 4; s++) {
		if (edges[s] < edges[(s + 1) % 4]) candidates.push(s);
	}
	// If opposite edges are equal (near-square), fall back to all 4 starts.
	const starts = candidates.length > 0 ? candidates : [0, 1, 2, 3];

	// Pick whichever start puts the "TL" corner closest to (0, 0).
	let bestStart = starts[0];
	let bestSum = Infinity;
	for (const s of starts) {
		const sum = ordered[s][0] + ordered[s][1];
		if (sum < bestSum) {
			bestSum = sum;
			bestStart = s;
		}
	}

	return [
		ordered[bestStart],
		ordered[(bestStart + 1) % 4],
		ordered[(bestStart + 2) % 4],
		ordered[(bestStart + 3) % 4]
	];
}

/**
 * Legacy sum/diff-based corner ordering. Kept for callers that don't care
 * about rotation (the 6-strategy detection pipeline uses the new
 * orderCornersForCard); retained so external imports don't break.
 */
export function orderCorners(pts: Array<[number, number]>): Array<[number, number]> {
	return orderCornersForCard(pts);
}

