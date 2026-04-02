import { json } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';

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

export async function POST({ request }) {
	const formData = await request.formData();
	const file = formData.get('file') as File;
	const mode = formData.get('mode') as string; // 'sync' or 'append'

	if (!file) {
		return json({ success: false, message: 'No file provided' }, { status: 400 });
	}

	const text = await file.text();
	const rows = parseCSV(text);

	if (rows.length === 0) {
		return json({ success: false, message: 'No data found in CSV' }, { status: 400 });
	}

	const findCard = sqlite.prepare(
		'SELECT id FROM cards WHERE set_code = ? AND collector_number = ? LIMIT 1'
	);

	const findCardByName = sqlite.prepare(
		'SELECT id FROM cards WHERE name = ? ORDER BY released_at DESC LIMIT 1'
	);

	const insertCollection = sqlite.prepare(
		`INSERT INTO collection_cards (card_id, quantity, condition, foil, notes, added_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	);

	let imported = 0;
	let skipped = 0;
	let notFound = 0;
	const notFoundCards: string[] = [];

	const transaction = sqlite.transaction(() => {
		// In sync mode, clear existing collection first
		if (mode === 'sync') {
			sqlite.exec('DELETE FROM collection_card_tags');
			sqlite.exec('DELETE FROM collection_cards');
		}

		for (const row of rows) {
			const setCode = row.Edition.toLowerCase();
			const collectorNumber = row['Collector Number'];
			const quantity = parseInt(row.Count) || 1;
			const condition = mapCondition(row.Condition);
			const foil = row.Foil === 'foil' || row.Foil === 'etched' ? 1 : 0;
			const purchasePrice = row['Purchase Price'] || null;
			const tags = row.Tags || '';

			// Try to find card by set_code + collector_number
			let card = findCard.get(setCode, collectorNumber) as { id: string } | undefined;

			// Fallback: search by name
			if (!card) {
				card = findCardByName.get(row.Name) as { id: string } | undefined;
			}

			if (!card) {
				notFound++;
				if (notFoundCards.length < 20) {
					notFoundCards.push(`${row.Name} (${setCode} #${collectorNumber})`);
				}
				continue;
			}

			const notes = [
				purchasePrice ? `Purchase: ${purchasePrice}` : '',
				tags ? `Moxfield tags: ${tags}` : ''
			].filter(Boolean).join('; ') || null;

			insertCollection.run(
				card.id,
				quantity,
				condition,
				foil,
				notes,
				new Date().toISOString()
			);

			imported++;
		}
	});

	transaction();

	return json({
		success: true,
		imported,
		skipped,
		notFound,
		notFoundCards,
		total: rows.length,
		mode
	});
}
