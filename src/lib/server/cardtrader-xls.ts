// Cardtrader order export (.xls / .xlsx) -> purchase-price rows.
//
// DB-free on purpose (the lookups are passed in), so the parser can be unit-tested
// against the spreadsheet library itself: `xlsx` comes from SheetJS's own CDN
// (see package.json), because the npm registry copy is frozen at the vulnerable
// 0.18.5 — this file is the only place that parses an uploaded workbook.

import * as XLSX from 'xlsx';

// One parsed price row. The endpoint resolves cardId + foil, then applies the
// update based on whether the user chose overwrite vs fill-only mode.
export interface PriceRow {
	cardId?: string;
	foil: 0 | 1;
	priceEur: number;
	// For diagnostics when a row cannot be matched to a card.
	label: string;
}

export interface ParsedPriceRows {
	rows: PriceRow[];
	parseErrors: string[];
	parseErrorCount: number;
}

type CardLookup = { id: string } | undefined;

export function parseNumber(v: unknown): number | null {
	if (typeof v === 'number' && isFinite(v)) return v;
	if (typeof v === 'string') {
		const n = parseFloat(v.replace(',', '.'));
		return isNaN(n) ? null : n;
	}
	return null;
}

export function parseCardtrader(
	bytes: ArrayBuffer,
	findBySetNum: (set: string, num: string) => CardLookup,
	findByName: (name: string) => CardLookup,
	findByNameAndNum: (name: string, num: string) => CardLookup
): ParsedPriceRows {
	let workbook: XLSX.WorkBook;
	try {
		workbook = XLSX.read(bytes, { type: 'array' });
	} catch (err) {
		return { rows: [], parseErrors: [`Could not read Excel file: ${(err as Error).message}`], parseErrorCount: 1 };
	}

	const sheet = workbook.Sheets[workbook.SheetNames[0]];
	if (!sheet) {
		return { rows: [], parseErrors: ['Workbook contains no sheets'], parseErrorCount: 1 };
	}

	const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { raw: true });
	const parseErrors: string[] = [];
	let parseErrorCount = 0;
	const rows: PriceRow[] = [];

	for (const record of records) {
		const itemName = String(record['Item Name'] ?? '').trim();
		const setCodeRaw = String(record['Set Code'] ?? '').trim();
		const collectorNumberRaw = record['Collector Number'];
		const collectorNumber = collectorNumberRaw != null ? String(collectorNumberRaw).trim() : '';
		const priceCents = parseNumber(record['Price in EUR Cents']);
		const foilVal = record['Foil/Reverse'];
		const foil: 0 | 1 = foilVal === true || foilVal === 1 || foilVal === 'true' ? 1 : 0;

		if (!itemName || priceCents == null) {
			parseErrorCount++;
			if (parseErrors.length < 20) {
				parseErrors.push(`${itemName || '(no name)'} — ${setCodeRaw} #${collectorNumber}`);
			}
			continue;
		}

		const priceEur = priceCents / 100;
		// Strip variant suffixes like "(Borderless)" for name-based matching
		// while preserving the original for the error label.
		const baseName = itemName.replace(/\s*\([^)]+\)\s*$/, '').trim();

		let card: CardLookup;

		if (collectorNumber) {
			const setCode = setCodeRaw.toLowerCase();
			card = findBySetNum(setCode, collectorNumber);
			// Cardtrader prefixes collector-booster sets with C (e.g. CINR for
			// Innistrad Remastered collectors). Scryfall's set for those same
			// cards is the base set code with collector numbers past the main run.
			if (!card && setCode.length > 2 && setCode.startsWith('c')) {
				card = findBySetNum(setCode.slice(1), collectorNumber);
			}
			if (!card && /^\d+$/.test(collectorNumber)) {
				const trimmed = String(parseInt(collectorNumber, 10));
				if (trimmed !== collectorNumber) {
					card = findBySetNum(setCodeRaw.toLowerCase(), trimmed);
					if (!card && setCode.length > 2 && setCode.startsWith('c')) {
						card = findBySetNum(setCode.slice(1), trimmed);
					}
				}
			}
			if (!card) card = findByNameAndNum(baseName, collectorNumber);
		}
		if (!card) card = findByName(baseName);
		if (!card) card = findByName(itemName);

		rows.push({
			cardId: card?.id,
			foil,
			priceEur,
			label: `${itemName} (${setCodeRaw}) ${collectorNumber}`.trim()
		});
	}

	return { rows, parseErrors, parseErrorCount };
}
