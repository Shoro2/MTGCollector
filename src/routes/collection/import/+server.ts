import { json } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { priceDataCache } from '$lib/server/cache';

interface MoxfieldRow {
	Count: string;
	Name: string;
	Edition: string;
	Condition: string;
	Language: string;
	Foil: string;
	Tags: string;
	'Collector Number': string;
	'Purchase Price': string;
}

interface ImportRow {
	setCode: string;
	collectorNumber: string;
	quantity: number;
	condition: string;
	foil: 0 | 1;
	purchasePrice: number | null;
	tags: string;
	originalName: string;
}

function parseCSV(text: string): MoxfieldRow[] {
	const lines = text.split('\n').filter((l) => l.trim());
	if (lines.length < 2) return [];

	// Parse header
	const header = parseCSVLine(lines[0]);
	const rows: MoxfieldRow[] = [];

	for (let i = 1; i < lines.length; i++) {
		const values = parseCSVLine(lines[i]);
		if (values.length !== header.length) continue;

		const row: Record<string, string> = {};
		for (let j = 0; j < header.length; j++) {
			row[header[j]] = values[j];
		}
		rows.push(row as unknown as MoxfieldRow);
	}

	return rows;
}

function parseCSVLine(line: string): string[] {
	const values: string[] = [];
	let current = '';
	let inQuotes = false;

	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === '"') {
			if (inQuotes && line[i + 1] === '"') {
				current += '"';
				i++;
			} else {
				inQuotes = !inQuotes;
			}
		} else if (char === ',' && !inQuotes) {
			values.push(current);
			current = '';
		} else {
			current += char;
		}
	}
	values.push(current);
	return values;
}

function mapCondition(moxfieldCondition: string): string {
	const map: Record<string, string> = {
		'Mint': 'near_mint',
		'Near Mint': 'near_mint',
		'Lightly Played': 'lightly_played',
		'Moderately Played': 'moderately_played',
		'Heavily Played': 'heavily_played',
		'Damaged': 'damaged'
	};
	return map[moxfieldCondition] || 'near_mint';
}

function moxfieldRowsToImportRows(rows: MoxfieldRow[]): ImportRow[] {
	return rows.map((row) => {
		const purchasePriceStr = row['Purchase Price'] || '';
		const parsedPrice = purchasePriceStr ? parseFloat(purchasePriceStr) : NaN;
		return {
			setCode: row.Edition.toLowerCase(),
			collectorNumber: row['Collector Number'],
			quantity: parseInt(row.Count) || 1,
			condition: mapCondition(row.Condition),
			foil: row.Foil === 'foil' || row.Foil === 'etched' ? 1 : 0,
			purchasePrice: isNaN(parsedPrice) ? null : parsedPrice,
			tags: row.Tags || '',
			originalName: row.Name
		};
	});
}

const TEXT_LINE_REGEX = /^\s*(\d+)\s+(.+?)\s+\(([A-Za-z0-9]+)\)\s+(\S+?)(\s+\*F\*)?\s*$/;

function parseTextDeckList(text: string): { rows: ImportRow[]; parseErrors: string[]; parseErrorCount: number } {
	const lines = text.split('\n');
	const parseErrors: string[] = [];
	let parseErrorCount = 0;
	const byKey = new Map<string, ImportRow>();
	const order: string[] = [];

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line.startsWith('#') || line.startsWith('//')) continue;

		const match = TEXT_LINE_REGEX.exec(line);
		if (!match) {
			parseErrorCount++;
			if (parseErrors.length < 20) parseErrors.push(line);
			continue;
		}

		const quantity = parseInt(match[1], 10) || 1;
		const name = match[2].trim();
		const setCode = match[3].toLowerCase();
		const collectorNumber = match[4];
		const foil: 0 | 1 = match[5] ? 1 : 0;

		const key = `${setCode}|${collectorNumber}|${foil}`;
		const existing = byKey.get(key);
		if (existing) {
			existing.quantity += quantity;
		} else {
			byKey.set(key, {
				setCode,
				collectorNumber,
				quantity,
				condition: 'near_mint',
				foil,
				purchasePrice: null,
				tags: '',
				originalName: name
			});
			order.push(key);
		}
	}

	return {
		rows: order.map((k) => byKey.get(k)!),
		parseErrors,
		parseErrorCount
	};
}

export async function POST({ request, locals }) {
	if (!locals.user) {
		return json({ success: false, message: 'Not authenticated' }, { status: 401 });
	}
	const userId = locals.user.id;

	const MAX_CSV_BYTES = 10 * 1024 * 1024;
	const MAX_TEXT_BYTES = 1 * 1024 * 1024;

	const formData = await request.formData();
	const format = (formData.get('format') as string) || 'csv';
	const mode = formData.get('mode') as string; // 'sync' or 'append'

	if (mode !== 'sync' && mode !== 'append') {
		return json({ success: false, message: 'Invalid mode' }, { status: 400 });
	}
	if (format !== 'csv' && format !== 'text') {
		return json({ success: false, message: 'Invalid format' }, { status: 400 });
	}

	let rows: ImportRow[] = [];
	let parseErrors: string[] = [];
	let parseErrorCount = 0;

	if (format === 'csv') {
		const file = formData.get('file');
		if (!(file instanceof File)) {
			return json({ success: false, message: 'No file provided' }, { status: 400 });
		}
		if (file.size > MAX_CSV_BYTES) {
			return json({ success: false, message: 'CSV too large (>10 MB)' }, { status: 413 });
		}
		const mime = (file.type || '').toLowerCase();
		const name = (file.name || '').toLowerCase();
		const knownCsvMimes = new Set([
			'text/csv',
			'application/csv',
			'application/vnd.ms-excel',
			'text/plain'
		]);
		const hasCsvExtension = name.endsWith('.csv');
		const looksLikeCsv = knownCsvMimes.has(mime) || (mime === '' && hasCsvExtension);
		if (!looksLikeCsv) {
			return json({ success: false, message: 'Only CSV files are accepted' }, { status: 400 });
		}

		const text = await file.text();
		const csvRows = parseCSV(text);
		if (csvRows.length === 0) {
			return json({ success: false, message: 'No data found in CSV' }, { status: 400 });
		}
		rows = moxfieldRowsToImportRows(csvRows);
	} else {
		const text = formData.get('text');
		if (typeof text !== 'string' || !text.trim()) {
			return json({ success: false, message: 'No text provided' }, { status: 400 });
		}
		// Byte length check (UTF-8)
		if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) {
			return json({ success: false, message: 'Text too large (>1 MB)' }, { status: 413 });
		}
		const parsed = parseTextDeckList(text);
		rows = parsed.rows;
		parseErrors = parsed.parseErrors;
		parseErrorCount = parsed.parseErrorCount;

		if (rows.length === 0 && parseErrorCount === 0) {
			return json({ success: false, message: 'No cards found in text' }, { status: 400 });
		}
	}

	const findCard = sqlite.prepare(
		'SELECT id FROM cards WHERE set_code = ? AND collector_number = ? LIMIT 1'
	);

	const findCardByName = sqlite.prepare(
		'SELECT id FROM cards WHERE name = ? ORDER BY released_at DESC LIMIT 1'
	);

	const insertCollection = sqlite.prepare(
		`INSERT INTO collection_cards (user_id, card_id, quantity, condition, foil, purchase_price, notes, added_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	);

	let imported = 0;
	let notFound = 0;
	const notFoundCards: string[] = [];

	const transaction = sqlite.transaction(() => {
		// In sync mode, clear existing collection first
		if (mode === 'sync') {
			sqlite.prepare('DELETE FROM collection_card_tags WHERE collection_card_id IN (SELECT id FROM collection_cards WHERE user_id = ?)').run(userId);
			sqlite.prepare('DELETE FROM collection_cards WHERE user_id = ?').run(userId);
		}

		for (const row of rows) {
			// Try set_code + collector_number, tolerant of leading zeros for numeric values
			let card = findCard.get(row.setCode, row.collectorNumber) as { id: string } | undefined;

			if (!card && /^\d+$/.test(row.collectorNumber)) {
				const trimmed = String(parseInt(row.collectorNumber, 10));
				if (trimmed !== row.collectorNumber) {
					card = findCard.get(row.setCode, trimmed) as { id: string } | undefined;
				}
			}

			// Fallback: search by name
			if (!card) {
				card = findCardByName.get(row.originalName) as { id: string } | undefined;
			}

			if (!card) {
				notFound++;
				if (notFoundCards.length < 20) {
					notFoundCards.push(`${row.originalName} (${row.setCode} #${row.collectorNumber})`);
				}
				continue;
			}

			const notes = row.tags ? `Moxfield tags: ${row.tags}` : null;

			insertCollection.run(
				userId,
				card.id,
				row.quantity,
				row.condition,
				row.foil,
				row.purchasePrice,
				notes,
				new Date().toISOString()
			);

			imported++;
		}
	});

	transaction();

	priceDataCache.invalidate(userId);

	return json({
		success: true,
		imported,
		skipped: 0,
		notFound,
		notFoundCards,
		parseErrors,
		parseErrorCount,
		total: rows.length,
		mode,
		format
	});
}
