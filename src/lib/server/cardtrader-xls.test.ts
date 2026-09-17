import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseCardtrader, parseNumber } from './cardtrader-xls';

const HEADER = ['Item Name', 'Set Code', 'Collector Number', 'Price in EUR Cents', 'Foil/Reverse'];

// A workbook written by the library itself, in the legacy binary format Cardtrader
// exports (.xls, BIFF8) or as .xlsx, handed over the way the endpoint gets it.
function workbook(rows: unknown[][], bookType: 'biff8' | 'xlsx' = 'biff8'): ArrayBuffer {
	const wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADER, ...rows]), 'Orders');
	const out = XLSX.write(wb, { type: 'array', bookType }) as ArrayBuffer;
	return out;
}

const catalogue: Record<string, string> = {
	'inr#0481': 'id-edgar',
	'mid#10': 'id-lantern',
	'tmt#85': 'id-bot'
};
const names: Record<string, string> = { 'Sol Ring': 'id-sol' };

const findBySetNum = (set: string, num: string) =>
	catalogue[`${set}#${num}`] ? { id: catalogue[`${set}#${num}`] } : undefined;
const findByName = (name: string) => (names[name] ? { id: names[name] } : undefined);
const findByNameAndNum = () => undefined;

describe('xlsx dependency', () => {
	it('is the patched SheetJS build, not the npm registry copy', () => {
		// The registry's `xlsx` stopped at 0.18.5 (prototype pollution < 0.19.3, ReDoS < 0.20.2).
		// package.json points at SheetJS's CDN; a plain `npm install xlsx` would bring 0.18.5 back.
		const [major, minor, patch] = XLSX.version.split('.').map(Number);
		expect(major * 10000 + minor * 100 + patch).toBeGreaterThanOrEqual(2002);
	});
});

describe('parseCardtrader', () => {
	it('reads a legacy .xls export: cents, foil flag, numeric collector numbers', () => {
		const bytes = workbook([
			['Lantern Bearer', 'MID', 10, 25, false],
			['Bot Bashing Time', 'TMT', '85', 1250, true]
		]);
		const { rows, parseErrorCount } = parseCardtrader(bytes, findBySetNum, findByName, findByNameAndNum);
		expect(parseErrorCount).toBe(0);
		expect(rows).toEqual([
			{ cardId: 'id-lantern', foil: 0, priceEur: 0.25, label: 'Lantern Bearer (MID) 10' },
			{ cardId: 'id-bot', foil: 1, priceEur: 12.5, label: 'Bot Bashing Time (TMT) 85' }
		]);
	});

	it('reads the same rows from an .xlsx file', () => {
		const bytes = workbook([['Lantern Bearer', 'MID', 10, 25, false]], 'xlsx');
		const { rows } = parseCardtrader(bytes, findBySetNum, findByName, findByNameAndNum);
		expect(rows).toEqual([{ cardId: 'id-lantern', foil: 0, priceEur: 0.25, label: 'Lantern Bearer (MID) 10' }]);
	});

	it('strips the collector-booster "C" prefix and falls back to the base name', () => {
		const bytes = workbook([
			['Edgar, Charmed Groom', 'CINR', '0481', 300, false],
			['Sol Ring (Borderless)', 'XYZ', '', 199, false]
		]);
		const { rows } = parseCardtrader(bytes, findBySetNum, findByName, findByNameAndNum);
		expect(rows.map((r) => r.cardId)).toEqual(['id-edgar', 'id-sol']);
		expect(rows[1].priceEur).toBe(1.99);
	});

	it('keeps unmatched rows and reports rows without a name or price', () => {
		const bytes = workbook([
			['Unknown Card', 'ABC', '1', 100, false],
			['', 'ABC', '2', 100, false],
			['No Price', 'ABC', '3', null, false]
		]);
		const { rows, parseErrors, parseErrorCount } = parseCardtrader(bytes, findBySetNum, findByName, findByNameAndNum);
		expect(rows).toEqual([{ cardId: undefined, foil: 0, priceEur: 1, label: 'Unknown Card (ABC) 1' }]);
		expect(parseErrorCount).toBe(2);
		expect(parseErrors).toHaveLength(2);
	});

	it('answers with a parse error instead of throwing on a file that is no workbook', () => {
		const junk = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3, 4]).buffer;
		const result = parseCardtrader(junk, findBySetNum, findByName, findByNameAndNum);
		expect(result.rows).toEqual([]);
		expect(result.parseErrorCount).toBe(1);
	});

});

describe('parseNumber', () => {
	it('accepts numbers and decimal commas', () => {
		expect(parseNumber(12)).toBe(12);
		expect(parseNumber('3,5')).toBe(3.5);
		expect(parseNumber('abc')).toBeNull();
		expect(parseNumber(undefined)).toBeNull();
	});
});
