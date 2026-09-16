import { describe, it, expect } from 'vitest';
import { parseCollectorInfo, fixOcrDigits, stripLeadingZeros } from './parse';

// Matches the language list the scanner passes in production (scan/+page.svelte).
const LANGS = 'EN|DE|FR|IT|ES|JA|PT|RU|ZH|KO';

const parse = (text: string) => parseCollectorInfo(text, LANGS);

describe('fixOcrDigits', () => {
	it('maps common letter misreads to digits', () => {
		expect(fixOcrDigits('O')).toBe('0');
		expect(fixOcrDigits('l')).toBe('1');
		expect(fixOcrDigits('I')).toBe('1');
		expect(fixOcrDigits('S')).toBe('5');
		expect(fixOcrDigits('B')).toBe('8');
		expect(fixOcrDigits('Z')).toBe('2');
	});

	it('strips any remaining non-digit characters', () => {
		expect(fixOcrDigits('12a3')).toBe('123');
		expect(fixOcrDigits('O12')).toBe('012');
		expect(fixOcrDigits('--')).toBe('');
	});
});

describe('stripLeadingZeros', () => {
	it('removes leading zeros but keeps at least one digit', () => {
		expect(stripLeadingZeros('007')).toBe('7');
		expect(stripLeadingZeros('0042')).toBe('42');
		expect(stripLeadingZeros('0')).toBe('0');
		expect(stripLeadingZeros('000')).toBe('0');
		expect(stripLeadingZeros('100')).toBe('100');
	});
});

describe('parseCollectorInfo — set code + number', () => {
	it('parses a standard 3-letter set code', () => {
		const r = parse('0234/275 R NEO • EN');
		expect(r.setCode).toBe('neo');
		expect(r.collectorNumber).toBe('234');
	});

	// Regression guard for the digit-set-code fix: these were all dropped when the
	// anchor required three *letters*.
	it('parses an alphanumeric set code with a trailing digit (M21)', () => {
		const r = parse('0156/280 C M21 • EN');
		expect(r.setCode).toBe('m21');
		expect(r.collectorNumber).toBe('156');
	});

	it('parses a leading-digit set code (2X2)', () => {
		const r = parse('0042/331 R 2X2 • EN');
		expect(r.setCode).toBe('2x2');
		expect(r.collectorNumber).toBe('42');
	});

	it('parses a digit-heavy set code (40K)', () => {
		const r = parse('0015/120 U 40K • EN');
		expect(r.setCode).toBe('40k');
		expect(r.collectorNumber).toBe('15');
	});

	it('skips a pure-number anchor candidate and keeps the lettered set code', () => {
		// "277 EN" would anchor as a set if digits were accepted blindly; the
		// at-least-one-letter guard skips it and finds "MOM".
		const r = parse('277 EN MOM EN');
		expect(r.setCode).toBe('mom');
	});

	it('preserves a variant suffix on the collector number', () => {
		const r = parse('0291a R MOM • EN');
		expect(r.setCode).toBe('mom');
		expect(r.collectorNumber).toBe('291a');
	});
});

describe('parseCollectorInfo — foil hint', () => {
	it('treats a "*" separator as a foil hint', () => {
		expect(parse('0100/275 M DOM * EN').foilFromText).toBe(true);
	});

	it('treats a bullet separator as non-foil', () => {
		expect(parse('0100/275 M DOM • EN').foilFromText).toBe(false);
	});
});

describe('parseCollectorInfo — generic fallback (no language anchor)', () => {
	it('still recovers an uppercase set code and number', () => {
		const r = parse('MOM 0042');
		expect(r.setCode).toBe('mom');
		expect(r.collectorNumber).toBe('42');
	});

	it('does not treat lowercase words as set codes', () => {
		const r = parse('bolt 0042 abc');
		expect(r.setCode).toBe('');
		expect(r.collectorNumber).toBe('42');
	});
});

describe('parseCollectorInfo number confidence', () => {
	const langs = 'EN|DE|FR';

	it('reports fraction numbers as reliable', () => {
		const r = parseCollectorInfo('040/277 C MID EN Ryan', langs);
		expect(r.collectorNumber).toBe('40');
		expect(r.numberSource).toBe('fraction');
	});

	it('takes the first number of a slash-less number/total pair', () => {
		const r = parseCollectorInfo('040 277 C MID EN', langs);
		expect(r.collectorNumber).toBe('40');
		expect(r.numberSource).toBe('pair');
	});

	it('rejects a merged number that exceeds the set total instead of guessing', () => {
		// OCR turned "180/277" into "1820 277"
		const r = parseCollectorInfo('1820 277 C MID EN Darren Tan', langs);
		expect(r.setCode).toBe('mid');
		expect(r.collectorNumber).toBe('');
	});

	it('marks a bare trailing number as weak', () => {
		// "Qs 277 C MID EN": the only number is the set total
		const r = parseCollectorInfo('Qs 277 C MID EN', langs);
		expect(r.collectorNumber).toBe('277');
		expect(r.numberSource).toBe('weak');
	});

	it('marks rarity-prefixed numbers as reliable', () => {
		const r = parseCollectorInfo('C 0052 TMT EN Miklos Ligeti', langs);
		expect(r.collectorNumber).toBe('52');
		expect(r.numberSource).toBe('rarity');
	});
});

describe('parseCollectorInfo without a set anchor', () => {
	it('still reports a rarity-prefixed number as reliable', () => {
		const r = parseCollectorInfo('Cc 0150 oT ad as Mat OLLIVIERHENRY', 'EN|DE|FR');
		expect(r.collectorNumber).toBe('150');
		expect(r.numberSource).toBe('rarity');
	});
});

describe('parseCollectorInfo — rarity letter', () => {
	it('reads the letter after a fraction', () => {
		const r = parse('180/277 C MID EN');
		expect(r.collectorNumber).toBe('180');
		expect(r.rarity).toBe('c');
	});

	it('reads the letter of a number/total pair', () => {
		const r = parse('040 277 U MID EN');
		expect(r.numberSource).toBe('pair');
		expect(r.rarity).toBe('u');
	});

	it('reads the letter before a padded number', () => {
		const r = parse('R 0156 TMT EN');
		expect(r.collectorNumber).toBe('156');
		expect(r.numberSource).toBe('rarity');
		expect(r.rarity).toBe('r');
	});

	it('reads a doubled letter in the generic fallback', () => {
		const r = parse('Cc 0150');
		expect(r.numberSource).toBe('rarity');
		expect(r.rarity).toBe('c');
	});

	it('reads the letter after a fraction without a language anchor', () => {
		const r = parse('118/277 C Story Spotlight');
		expect(r.collectorNumber).toBe('118');
		expect(r.rarity).toBe('c');
	});

	it('reports no letter for a weak number or when the set code follows the fraction', () => {
		expect(parse('0098 . aa mt').rarity).toBe('');
		expect(parse('24/277 MID EN').rarity).toBe('');
	});
});

describe('parseCollectorInfo — dropped digits', () => {
	it('downgrades a fraction whose numerator is shorter than the total', () => {
		const r = parse('4/277 C MID EN');
		expect(r.collectorNumber).toBe('4');
		expect(r.numberSource).toBe('weak');
		expect(parse('24/7277 MID EN').numberSource).toBe('weak');
		expect(parse('040/277 C MID EN').numberSource).toBe('fraction');
	});

	it('downgrades a rarity-prefixed number with fewer than three digits', () => {
		expect(parse('C 7 TMT EN').numberSource).toBe('weak');
		expect(parse('C 0156 TMT EN').numberSource).toBe('rarity');
	});

	it('applies the same rules without a language anchor', () => {
		expect(parse('40/277 C Story').numberSource).toBe('weak');
		expect(parse('118/277 C Story').numberSource).toBe('fraction');
		expect(parse('Cc 0150').numberSource).toBe('rarity');
		expect(parse('C 15').numberSource).toBe('weak');
	});
});

describe('parseCollectorInfo — land rarity letter', () => {
	it('accepts the L printed on basic lands as the rarity prefix', () => {
		const r = parse('axter Stockman L 0187 TMT EN');
		expect(r.collectorNumber).toBe('187');
		expect(r.numberSource).toBe('rarity');
		expect(r.rarity).toBe('l');
	});
});

describe('parseCollectorInfo — language', () => {
	it('reports the language code read after the set code', () => {
		expect(parse('C 0156 TMT EN').language).toBe('EN');
		expect(parse('180/277 C MID • DE').language).toBe('DE');
		expect(parse('Cc 0150').language).toBe('');
	});
});

describe('parseCollectorInfo — rarity letter glued to the digits', () => {
	it('treats "C0047" as a rarity-prefixed number', () => {
		const r = parse('eee et eta C0047');
		expect(r.collectorNumber).toBe('47');
		expect(r.numberSource).toBe('rarity');
		expect(r.rarity).toBe('c');
	});
});
