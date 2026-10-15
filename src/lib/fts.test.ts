import { describe, expect, it } from 'vitest';
import { ftsPrefixQuery } from './fts';

describe('ftsPrefixQuery', () => {
	it('splits at apostrophes like the FTS tokenizer does', () => {
		expect(ftsPrefixQuery("Teferi's Protection")).toBe('"Teferi"* "s"* "Protection"*');
		expect(ftsPrefixQuery('Michiko\u2019s Reign of Truth')).toBe('"Michiko"* "s"* "Reign"* "of"* "Truth"*');
	});
	it('keeps operators and quotes from reaching FTS5 syntax', () => {
		expect(ftsPrefixQuery('"fire" OR name:ice')).toBe('"fire"* "OR"* "name:ice"*');
		expect(ftsPrefixQuery('  \' "  ')).toBe('');
	});
});
