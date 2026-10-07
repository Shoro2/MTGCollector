import { CONDITIONS, cleanLocation } from './collection-fields';
import { LANGUAGES } from './utils';

export const IMPORT_FIELDS = [
	['id', 'Scryfall ID'], ['name', 'Card name'], ['set', 'Set code'], ['setName', 'Set name'],
	['number', 'Collector number'], ['quantity', 'Quantity'], ['finish', 'Finish / foil'],
	['condition', 'Condition'], ['language', 'Language'], ['price', 'Purchase price per copy'],
	['currency', 'Purchase price currency'], ['location', 'Location / folder'], ['notes', 'Notes'],
	['tags', 'Tags'], ['added', 'Date added']
] as const;
export type ImportField = typeof IMPORT_FIELDS[number][0];
export type ImportMapping = Partial<Record<ImportField, string>>;
export type ImportOptions = { mapping?: ImportMapping; currency: string; location: string; ignorePrices: boolean };
export type ImportEntry = {
	line: number; id: string; name: string; set: string; setName: string; number: string; quantity: number;
	foil: number; condition: string; language: string; purchasePrice: number | null;
	location: string; notes: string; tags: string[]; addedAt: string | null;
};
export type ImportIssue = { line: number; name: string; message: string };
const normal = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
const aliases: Record<ImportField, string[]> = {
	id: ['scryfallid', 'scryfalluuid'], name: ['name', 'cardname'], set: ['setcode', 'edition', 'editioncode', 'set'],
	setName: ['setname', 'editionname'], number: ['collectornumber', 'cardnumber', 'collectorno', 'number'],
	quantity: ['quantity', 'count', 'amount'], finish: ['foil', 'printing', 'finish'],
	condition: ['condition'], language: ['language', 'lang'], price: ['purchaseprice', 'pricebought', 'acquiredprice', 'purchasepriceeur'],
	currency: ['purchasepricecurrency', 'currency'], location: ['location', 'foldername', 'bindername', 'listname', 'folder', 'binder'],
	notes: ['notes', 'note'], tags: ['tags', 'tagsjson'], added: ['dateadded', 'addedat', 'datebought', 'acquireddate']
};

/** RFC-style quoted fields, including embedded newlines. Delimiter detection never reads data values. */
export function readCsv(text: string): string[][] {
	text = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	const first = text.split('\n')[0];
	const delimiter = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
	const rows: string[][] = [];
	let row: string[] = [], field = '', quoted = false, endedQuote = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
			else if (ch === '"') { quoted = false; endedQuote = true; }
			else field += ch;
		} else if (ch === delimiter || ch === '\n') {
			row.push(field); field = ''; endedQuote = false;
			if (ch === '\n') { if (row.some(v => v.trim())) rows.push(row); row = []; }
		} else if (ch === '"' && !field && !endedQuote) quoted = true;
		else if (endedQuote && ch.trim()) throw new Error('Unexpected text after a quoted CSV field.');
		else if (!endedQuote) field += ch;
	}
	if (quoted) throw new Error('The CSV contains an unclosed quoted field.');
	row.push(field); if (row.some(v => v.trim())) rows.push(row);
	if (rows.length > 20001) throw new Error('Import at most 20,000 entries at a time.');
	return rows;
}

export function inferMapping(headers: string[]): ImportMapping {
	const mapping: ImportMapping = {};
	for (const [key] of IMPORT_FIELDS) {
		const matches = headers.filter(header => aliases[key].includes(normal(header)));
		if (matches.length === 1) mapping[key] = matches[0];
	}
	return mapping;
}

function decimal(text: string): number {
	if (!/^\d+(?:[.,]\d+)?$/.test(text)) throw new Error('Invalid purchase price. Use a nonnegative amount per copy.');
	const value = Number(text.replace(',', '.'));
	if (!Number.isFinite(value) || value > 1e9) throw new Error('Purchase price is too large.');
	return value;
}

function conditionOf(text: string) {
	const key = normal(text);
	const short: Record<string, string> = { nm: 'near_mint', mint: 'near_mint', m: 'near_mint', lp: 'lightly_played',
		ex: 'lightly_played', excellent: 'lightly_played', mp: 'moderately_played', hp: 'heavily_played', dmg: 'damaged' };
	const condition = CONDITIONS.find(c => normal(c.value) === key)?.value ?? short[key];
	if (!condition && text) throw new Error(`Unsupported condition: ${text}. Map it before importing.`);
	return condition || 'near_mint';
}

export function parseCollectionImport(text: string, format: 'csv' | 'text', options: ImportOptions) {
	let table: string[][];
	if (format === 'text') {
		table = [['Quantity', 'Name', 'Set Code', 'Collector Number', 'Foil']];
		for (const line of text.split(/\r?\n/).filter(l => l.trim() && !/^\s*(#|\/\/)/.test(l))) {
			const match = /^\s*(\d+)\s+(.+?)\s+\(([\w]+)\)\s+(\S+?)(\s+\*F\*)?\s*$/.exec(line);
			table.push(match ? [match[1], match[2], match[3], match[4], match[5] ? 'foil' : ''] : [line]);
		}
	} else table = readCsv(text);
	if (table.length < 2) throw new Error('No card entries found.');
	if (table.length > 20001) throw new Error('Import at most 20,000 entries at a time.');
	const headers = table[0].map(h => h.trim());
	if (new Set(headers).size !== headers.length || headers.some(h => !h)) throw new Error('CSV headers must be unique and nonempty.');
	const rawMapping = format === 'text' ? inferMapping(headers) : options.mapping ?? inferMapping(headers);
	if (!rawMapping || typeof rawMapping !== 'object' || Array.isArray(rawMapping)) throw new Error('Invalid column mapping.');
	for (const [field, header] of Object.entries(rawMapping)) {
		if (!IMPORT_FIELDS.some(([key]) => key === field) || header && !headers.includes(header)) throw new Error('Invalid column mapping.');
	}
	const mapping: ImportMapping = Object.fromEntries(IMPORT_FIELDS.filter(([key]) => rawMapping[key]).map(([key]) => [key, rawMapping[key]]));
	const entries: ImportEntry[] = [], issues: ImportIssue[] = [];
	for (let i = 1; i < table.length; i++) {
		const cells = table[i];
		const get = (key: ImportField) => mapping[key] ? (cells[headers.indexOf(mapping[key]!)] ?? '').trim() : '';
		try {
			if (cells.length !== headers.length) throw new Error('The row has a different number of fields than the header.');
			const quantityText = get('quantity');
			const quantity = quantityText ? Number(quantityText) : 1;
			if (!/^\d*$/.test(quantityText) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100000) throw new Error('Quantity must be a whole number between 1 and 100,000.');
			const finish = normal(get('finish'));
			if (!['', 'normal', 'regular', 'nonfoil', 'false', '0', 'no', 'foil', 'true', '1', 'yes'].includes(finish)) {
				throw new Error(`Unsupported finish: ${get('finish')}. Etched and special finishes need separate review.`);
			}
			const rawLang = get('language').toLowerCase();
			const language = rawLang ? LANGUAGES.find(l => l.code === rawLang || l.label.toLowerCase() === rawLang)?.code : 'en';
			if (!language) throw new Error(`Unknown language: ${rawLang}.`);
			const price = options.ignorePrices ? '' : get('price');
			const currency = (get('currency') || options.currency).toUpperCase();
			if (price && currency !== 'EUR') throw new Error(`Purchase price is ${currency || 'in an unknown currency'}. Convert it to EUR or choose Ignore purchase prices.`);
			const added = get('added');
			if (added && (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/.test(added) || !Number.isFinite(Date.parse(added)) || new Date(added).toISOString().slice(0, 10) !== added.slice(0, 10))) {
				throw new Error('Date added must use YYYY-MM-DD or an ISO UTC timestamp. Leave the column unmapped to use today.');
			}
			const tags = mapping.tags && normal(mapping.tags) === 'tagsjson' ? JSON.parse(get('tags') || '[]') : get('tags').split(/[;,]/).map(t => t.trim()).filter(Boolean);
			if (!Array.isArray(tags) || tags.length > 100 || tags.some(t => typeof t !== 'string' || t.length > 200)) throw new Error('Invalid tags (maximum 100 tags of 200 characters).');
			if (get('notes').length > 10000) throw new Error('Notes are too long (maximum 10,000 characters).');
			entries.push({ line: i + 1, id: get('id'), name: get('name'), set: get('set').toLowerCase(), setName: get('setName'),
				number: get('number'), quantity, foil: ['foil', 'true', '1', 'yes'].includes(finish) ? 1 : 0,
				condition: conditionOf(get('condition')), language, purchasePrice: price ? decimal(price) : null,
				location: cleanLocation(get('location') || options.location), notes: get('notes'), tags,
				addedAt: added ? new Date(added).toISOString() : null });
		} catch (error) { issues.push({ line: i + 1, name: get('name'), message: (error as Error).message }); }
	}
	return { headers, mapping, entries, issues, total: table.length - 1 };
}
