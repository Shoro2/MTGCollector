import { describe, expect, it } from 'vitest';
import { PrintedNameIndex, printedNameRows } from './printed-name-index';

const de = new Set(['de']);

describe('printedNameRows', () => {
	it('takes the printed name of a card object in a wanted language, under its English name', () => {
		expect(printedNameRows({ name: 'War Horn', lang: 'de', layout: 'normal', printed_name: 'Kriegshorn' }, de)).toEqual([
			{ name: 'War Horn', lang: 'de', printed: 'Kriegshorn' }
		]);
	});

	it('skips English objects, unwanted languages, art-series records and names spelled like the English one', () => {
		expect(printedNameRows({ name: 'War Horn', lang: 'en', printed_name: 'War Horn' }, de)).toEqual([]);
		expect(printedNameRows({ name: 'War Horn', lang: 'fr', printed_name: 'Cor de guerre' }, de)).toEqual([]);
		expect(printedNameRows({ name: 'War Horn // War Horn', lang: 'de', layout: 'art_series', printed_name: 'Kriegshorn' }, de)).toEqual([]);
		expect(printedNameRows({ name: 'Kothophed, Soul Hoarder', lang: 'de', printed_name: 'kothophed soul hoarder' }, de)).toEqual([]);
	});

	it('takes each face of a double-faced card', () => {
		const rows = printedNameRows({
			name: 'Delver of Secrets // Insectile Aberration', lang: 'de', layout: 'transform',
			card_faces: [{ name: 'Delver of Secrets', printed_name: 'Geheimnisstöberer' }, { name: 'Insectile Aberration', printed_name: 'Insekten-Scheußlichkeit' }]
		}, de);
		expect(rows.map((r) => r.printed)).toEqual(['Geheimnisstöberer', 'Insekten-Scheußlichkeit']);
		expect(rows.every((r) => r.name === 'Delver of Secrets // Insectile Aberration')).toBe(true);
	});
});

describe('PrintedNameIndex', () => {
	const index = new PrintedNameIndex([
		{ name: 'War Horn', lang: 'de', printed: 'Kriegshorn' },
		{ name: 'Infinite Obliteration', lang: 'de', printed: 'Endlose Auslöschung' },
		{ name: "Pyromancer's Goggles", lang: 'de', printed: 'Schutzbrille der Pyromagierin' },
		{ name: 'Painful Truths', lang: 'de', printed: 'Schmerzliche Wahrheit' },
		{ name: 'Delver of Secrets // Insectile Aberration', lang: 'de', printed: 'Insekten-Scheußlichkeit' },
		{ name: 'War Horn', lang: 'de', printed: 'Kriegshorn' } // duplicate rows collapse
	]);

	it('lists the printed names of an English name', () => {
		expect(index.aliasesOf('War Horn')).toEqual([{ alias: 'Kriegshorn', lang: 'de' }]);
		expect(index.aliasesOf('Lightning Bolt')).toEqual([]);
		expect(index.size).toBe(5);
	});

	it('matches an OCR text without umlauts exactly once normalised', () => {
		expect(index.match('Endlose Ausloschung')).toEqual([{ name: 'Infinite Obliteration', alias: 'Endlose Auslöschung', lang: 'de', score: 1 }]);
		expect(index.match('Insekten-Scheusslichkeit')[0]).toMatchObject({ name: 'Delver of Secrets // Insectile Aberration', score: 1 });
	});

	it('finds a partial or misread German name by edit distance', () => {
		const [goggles] = index.match('Schutzbrille der Pyromagi');
		expect(goggles.name).toBe("Pyromancer's Goggles");
		expect(goggles.score).toBeGreaterThan(0.8);
		expect(index.match('Schmerzliche Wahrhet')[0].name).toBe('Painful Truths');
	});

	it('does not match short texts or unrelated words by edit distance', () => {
		expect(index.match('Krieg')).toEqual([]);
		expect(index.match('Lightning Bolt')).toEqual([]);
	});
});
