/** Load an image file into an HTMLImageElement that's ready to draw. */
export function loadImage(file: File): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		// Revoke the object URL once the bitmap is decoded (or on error). The
		// loaded <img> stays drawable to a canvas afterwards, and not revoking
		// leaks the blob for the lifetime of the page — one leak per scanned image.
		const url = URL.createObjectURL(file);
		img.onload = () => {
			URL.revokeObjectURL(url);
			resolve(img);
		};
		img.onerror = (e) => {
			URL.revokeObjectURL(url);
			reject(e);
		};
		img.src = url;
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
 * 1. Sorting the corners around their centroid and ensuring a consistent
 *    clockwise traversal (the input order may be crossed).
 * 2. Treating the pair of edges longer than their neighbours as the
 *    card's long sides, and picking the short edge to serve as the
 *    "top" of the warped output.
 * 3. Breaking ties by picking whichever valid starting index puts the
 *    top-left as the corner closest to the image top-left corner.
 */
export function orderCornersForCard(pts: Array<[number, number]>): Array<[number, number]> {
	if (pts.length !== 4) return pts;

	// Step 1: put the corners in polygon order around their centroid, then
	// enforce clockwise traversal (image coords: y increases downward, so
	// positive signed area == clockwise). The input order is not trusted: the
	// live detector's plausibility check sorts the corners itself, so a
	// crossed (bow-tie) order from approxPolyDP passed it, and the warp of
	// TL(797,861) TR(299,597) BR(832,1419) BL(288,1440) was unreadable
	// (iPhone scan log, 2026-10-23).
	const cx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
	const cy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
	const ordered = [...pts].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
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

/**
 * Where a `srcW x srcH` image lands inside a `boxW x boxH` box under CSS
 * `object-fit: contain` — uniform scale, centred, letterboxed. Used to map
 * video-pixel coordinates onto an overlay canvas that covers the whole box:
 * scaling x and y independently (boxW/srcW, boxH/srcH) distorts the outline
 * whenever the box and stream aspect ratios differ, e.g. a portrait phone
 * stream in a landscape viewfinder.
 */
export function fitContain(
	srcW: number,
	srcH: number,
	boxW: number,
	boxH: number
): { x: number; y: number; width: number; height: number; scale: number } {
	if (srcW <= 0 || srcH <= 0 || boxW <= 0 || boxH <= 0) {
		return { x: 0, y: 0, width: 0, height: 0, scale: 0 };
	}
	const scale = Math.min(boxW / srcW, boxH / srcH);
	const width = srcW * scale;
	const height = srcH * scale;
	return { x: (boxW - width) / 2, y: (boxH - height) / 2, width, height, scale };
}

/**
 * True when an axis-aligned rect comes within `marginPx` of any frame edge.
 * A card that touches the edge is (partially) cut off: its name or collector
 * line may lie outside the frame, so the live scanner shouldn't auto-capture.
 */
export function touchesFrameEdge(
	rect: { x: number; y: number; width: number; height: number },
	frameW: number,
	frameH: number,
	marginPx: number
): boolean {
	return (
		rect.x <= marginPx ||
		rect.y <= marginPx ||
		rect.x + rect.width >= frameW - marginPx ||
		rect.y + rect.height >= frameH - marginPx
	);
}

/**
 * True when a detected card quad reaches the photo's edge (within `marginFrac`
 * of the long edge) or lies partly outside it: the card is probably cut off,
 * and its name bar or collector line with it. Two of the three uploads of an
 * iPhone session (2026-10-23) were such photos: a corner at x = -118 and one at
 * y = 4287 in a 3024x4032 picture; neither card was read.
 */
export function cardCutOffByFrame(corners: Array<[number, number]>, frameW: number, frameH: number, marginFrac = 0.005): boolean {
	const m = Math.max(frameW, frameH) * marginFrac;
	return corners.some(([x, y]) => x <= m || y <= m || x >= frameW - m || y >= frameH - m);
}
