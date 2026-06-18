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
