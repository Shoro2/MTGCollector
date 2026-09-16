import { describe, it, expect } from 'vitest';
import { ctcDecode } from './ctc';

describe('ctcDecode', () => {
	const dict = ['', 'a', 'b', ' '];
	// one-hot rows: [blank, a, b, space]
	const rows = (...idx: number[]) => Float32Array.from(idx.flatMap((i) => [0, 1, 2, 3].map((k) => (k === i ? 0.9 : 0.1 / 3))));

	it('drops blanks and collapses repeats', () => {
		const logits = rows(1, 1, 0, 2, 2, 0, 3, 1);
		expect(ctcDecode(logits, 8, 4, dict)).toEqual({ text: 'ab a', confidence: expect.closeTo(0.9, 5) });
	});

	it('keeps a repeated character when a blank separates the steps', () => {
		expect(ctcDecode(rows(1, 0, 1), 3, 4, dict).text).toBe('aa');
	});

	it('returns an empty result for all-blank output', () => {
		expect(ctcDecode(rows(0, 0, 0), 3, 4, dict)).toEqual({ text: '', confidence: 0 });
	});
});
