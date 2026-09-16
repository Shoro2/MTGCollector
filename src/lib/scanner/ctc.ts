/** CTC decoding for the PaddleOCR recognition output — pure, unit-tested (see paddle.ts). */

/**
 * Greedy CTC decode of the model output (T steps x C classes, row-major):
 * argmax per step, drop blanks (class 0) and repeats. Confidence is the mean
 * probability of the kept characters.
 */
export function ctcDecode(logits: ArrayLike<number>, steps: number, classes: number, dict: string[]): { text: string; confidence: number } {
	let text = '';
	let last = -1;
	let sum = 0;
	let kept = 0;
	for (let t = 0; t < steps; t++) {
		let best = 0;
		let bestIdx = 0;
		const base = t * classes;
		for (let k = 0; k < classes; k++) {
			const v = logits[base + k];
			if (v > best) {
				best = v;
				bestIdx = k;
			}
		}
		if (bestIdx !== 0 && bestIdx !== last) {
			text += dict[bestIdx] ?? '';
			sum += best;
			kept++;
		}
		last = bestIdx;
	}
	return { text: text.trim(), confidence: kept ? sum / kept : 0 };
}
