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
 */
export function orderCorners(pts: Array<[number, number]>): Array<[number, number]> {
	// Sort by sum (x+y) to find TL and BR
	const sorted = [...pts].sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
	const tl = sorted[0];
	const br = sorted[3];
	// Sort by diff (x-y) to find TR and BL
	const sorted2 = [...pts].sort((a, b) => (a[0] - a[1]) - (b[0] - b[1]));
	const bl = sorted2[0];
	const tr = sorted2[3];
	return [tl, tr, br, bl];
}
