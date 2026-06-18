import { describe, it, expect } from 'vitest';
import { similarity, bestNameMatch } from './similarity';

describe('similarity', () => {
	it('returns 1 for identical strings', () => {
		expect(similarity('Lightning Bolt', 'Lightning Bolt')).toBe(1);
	});

	it('is case-insensitive', () => {
		expect(similarity('ABC', 'abc')).toBe(1);
	});

	it('treats two empty strings as identical', () => {
		expect(similarity('', '')).toBe(1);
	});

	it('returns 0 when one string is empty', () => {
		expect(similarity('abc', '')).toBe(0);
	});

	it('scores partial matches by normalized edit distance', () => {
		// classic kitten/sitting: edit distance 3 over max length 7
		expect(similarity('kitten', 'sitting')).toBeCloseTo(1 - 3 / 7, 4);
	});
});

describe('bestNameMatch', () => {
	it('picks the highest-scoring name and dedupes by name', () => {
		const results = [
			{ name: 'Bolt' },
			{ name: 'Lightning Bolt' },
			{ name: 'Lightning Bolt' }
		];
		const best = bestNameMatch(results, 'Lightning Bolt');
		expect(best.name).toBe('Lightning Bolt');
		expect(best.score).toBe(1);
	});

	it('returns an empty match for an empty result set', () => {
		expect(bestNameMatch([], 'anything')).toEqual({ name: '', score: 0 });
	});
});
