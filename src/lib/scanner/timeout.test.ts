import { describe, expect, it } from 'vitest';
import { withTimeout } from './timeout';

describe('withTimeout', () => {
	it('passes a value through when the promise settles first', async () => {
		await expect(withTimeout(Promise.resolve(42), 1000, 'quick')).resolves.toBe(42);
	});

	it('rejects with the label once the deadline passes', async () => {
		const never = new Promise<number>(() => {});
		await expect(withTimeout(never, 20, 'PaddleOCR engine load')).rejects.toThrow('PaddleOCR engine load timed out after 20 ms');
	});

	it('propagates the original rejection', async () => {
		await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'x')).rejects.toThrow('boom');
	});
});
