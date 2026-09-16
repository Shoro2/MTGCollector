import { describe, it, expect } from 'vitest';
import { similarity, bestNameMatch, normalizeName, prefixSimilarity, looksLikeOcrJunk } from './similarity';

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

describe('normalizeName', () => {
	it('strips diacritics so accented names fold to ASCII', () => {
		expect(normalizeName('Lim-Dûl')).toBe('lim dul');
		expect(normalizeName('Jötun Grunt')).toBe('jotun grunt');
		expect(normalizeName('Séance')).toBe('seance');
	});

	it('folds ligatures that NFD does not decompose', () => {
		expect(normalizeName('Æther Vial')).toBe('aether vial');
	});

	it('reduces punctuation and runs of whitespace to single spaces', () => {
		expect(normalizeName('Jace, the Mind Sculptor')).toBe('jace the mind sculptor');
		expect(normalizeName("Urza's  Tower")).toBe('urza s tower');
	});
});

describe('similarity with normalization', () => {
	it('scores accent/punctuation-only differences as a perfect match', () => {
		expect(similarity('Jace, the Mind Sculptor', 'Jace the Mind Sculptor')).toBe(1);
		expect(similarity("Lim-Dûl's Vault", "Lim-Dul's Vault")).toBe(1);
		expect(similarity('Æther Vial', 'Aether Vial')).toBe(1);
	});
});


describe('looksLikeOcrJunk', () => {
	it('flags mana-symbol fragments and frame noise', () => {
		for (const w of ['SSSERRY', 'WU', 'i', 'A', 'Rrr', 'GGB', 'xz']) expect(looksLikeOcrJunk(w), w).toBe(true);
	});

	it('keeps ordinary name words', () => {
		for (const w of ['Ball', 'Bolt', 'the', 'Sculptor', 'Augustin', 'Fish']) expect(looksLikeOcrJunk(w), w).toBe(false);
	});
});

describe('prefixSimilarity', () => {
	it('matches a clean name followed by junk', () => {
		expect(prefixSimilarity('Lightning Bolt A SSSERRY', 'Lightning Bolt')).toBe(1);
	});

	it('refuses when the remainder contains a real word', () => {
		expect(prefixSimilarity('Fire Ball', 'Fire')).toBe(0);
		expect(prefixSimilarity('Island Fish Jasconius', 'Island')).toBe(0);
	});

	it('refuses prefixes that are far shorter than the candidate', () => {
		expect(prefixSimilarity('Bolt SSSERRY', 'Lightning Bolt')).toBe(0);
	});

	it('is 0 for a single-word OCR string', () => {
		expect(prefixSimilarity('Opt', 'Opt')).toBe(0);
	});
});

describe('bestNameMatch with OCR junk', () => {
	it('accepts a name whose OCR carries mana-cost junk at the end', () => {
		const best = bestNameMatch([{ name: 'Lightning Bolt' }, { name: 'Lightning Helix' }], 'Lightning Bolt A SSSERRY');
		expect(best.name).toBe('Lightning Bolt');
		expect(best.score).toBeGreaterThanOrEqual(0.9);
	});

	it('still prefers the full-string match over a shorter prefix candidate', () => {
		const best = bestNameMatch([{ name: 'Fire' }, { name: 'Fireball' }], 'Fire Ball');
		expect(best.name).toBe('Fireball');
	});

	it('does not raise the score when the tail is real text', () => {
		const best = bestNameMatch([{ name: 'Island' }], 'Island Fish Jasconius');
		expect(best.score).toBeLessThan(0.6);
	});
});
