/**
 * Bound a promise by a deadline. The lazily loaded OCR engines come from a CDN
 * (or the self-hosted copies) and a stalled download would otherwise hang a
 * scan forever — the harness once waited 15 minutes for a "Done!" that never
 * came. OpenCV has had its own load timeout for the same reason.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			}
		);
	});
}
