import { json } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { priceDataCache } from '$lib/server/cache';
import { getUsdToEurRate } from '$lib/server/exchange-rate';
import { parseCardtrader, parseNumber, type PriceRow } from '$lib/server/cardtrader-xls';

const MAX_CSV_BYTES = 5 * 1024 * 1024;
const MAX_XLS_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 1 * 1024 * 1024;

const TEXT_LINE_REGEX = /^\s*(\d+)\s+(.+?)\s+\(([A-Za-z0-9]+)\)\s+(\S+?)\s+([\d.,]+)\s*([EeDd])\s*$/;

async function parseTextBody(
	text: string,
	findBySetNum: (set: string, num: string) => { id: string } | undefined,
	findByName: (name: string) => { id: string } | undefined
): Promise<{ rows: PriceRow[]; parseErrors: string[]; parseErrorCount: number }> {
	const usdRate = await getUsdToEurRate();
	const parseErrors: string[] = [];
	let parseErrorCount = 0;
	const rows: PriceRow[] = [];

	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line.startsWith('#') || line.startsWith('//')) continue;

		// Try the full form (with price). If absent the line is a normal
		// deck-list entry — reject it with a parse error.
		const priceMatch = TEXT_LINE_REGEX.exec(line);
		if (!priceMatch) {
			parseErrorCount++;
			if (parseErrors.length < 20) parseErrors.push(line);
			continue;
		}

		const name = priceMatch[2].trim();
		const setCode = priceMatch[3].toLowerCase();
		const collectorNumber = priceMatch[4];
		const priceRaw = parseFloat(priceMatch[5].replace(',', '.'));
		const currency = priceMatch[6].toUpperCase();

		if (!isFinite(priceRaw)) {
			parseErrorCount++;
			if (parseErrors.length < 20) parseErrors.push(line);
			continue;
		}

		// USD → EUR for D-suffix, raw for E-suffix.
		const priceEur = currency === 'D' ? priceRaw * usdRate : priceRaw;

		let card = findBySetNum(setCode, collectorNumber);
		if (!card && /^\d+$/.test(collectorNumber)) {
			const trimmed = String(parseInt(collectorNumber, 10));
			if (trimmed !== collectorNumber) card = findBySetNum(setCode, trimmed);
		}
		if (!card) card = findByName(name);

		rows.push({
			cardId: card?.id,
			foil: 0,
			priceEur,
			label: `${name} (${setCode.toUpperCase()}) ${collectorNumber}`
		});
	}

	return { rows, parseErrors, parseErrorCount };
}

async function parseCardmarket(
	text: string,
	findByCmId: (id: number) => { id: string } | undefined
): Promise<{ rows: PriceRow[]; parseErrors: string[]; parseErrorCount: number }> {
	const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
	if (lines.length < 2) {
		return { rows: [], parseErrors: [], parseErrorCount: 0 };
	}

	const header = lines[0].split(';').map((h) => h.trim());
	const colIdProduct = header.indexOf('idProduct');
	const colPrice = header.indexOf('price');
	const colIsFoil = header.indexOf('isFoil');
	if (colIdProduct === -1 || colPrice === -1) {
		return {
			rows: [],
			parseErrors: ['Missing required columns idProduct/price in CSV header'],
			parseErrorCount: 1
		};
	}

	const parseErrors: string[] = [];
	let parseErrorCount = 0;
	const rows: PriceRow[] = [];

	for (let i = 1; i < lines.length; i++) {
		const cols = lines[i].split(';');
		const idProduct = parseInt(cols[colIdProduct], 10);
		const price = parseNumber(cols[colPrice]);
		if (!idProduct || price == null) {
			parseErrorCount++;
			if (parseErrors.length < 20) parseErrors.push(lines[i]);
			continue;
		}
		const foilRaw = colIsFoil >= 0 ? (cols[colIsFoil] ?? '').toLowerCase() : '';
		const foil: 0 | 1 = foilRaw === 'true' || foilRaw === '1' || foilRaw === 'x' ? 1 : 0;

		const card = findByCmId(idProduct);
		rows.push({
			cardId: card?.id,
			foil,
			priceEur: price,
			label: `Cardmarket product #${idProduct}`
		});
	}

	return { rows, parseErrors, parseErrorCount };
}

export async function POST({ request, locals }) {
	if (!locals.user) {
		return json({ success: false, message: 'Not authenticated' }, { status: 401 });
	}
	const userId = locals.user.id;

	const formData = await request.formData();
	const format = (formData.get('format') as string) || '';
	const mode = (formData.get('mode') as string) || 'fill';
	if (format !== 'text' && format !== 'cardmarket' && format !== 'cardtrader') {
		return json({ success: false, message: 'Invalid format' }, { status: 400 });
	}
	if (mode !== 'fill' && mode !== 'overwrite') {
		return json({ success: false, message: 'Invalid mode' }, { status: 400 });
	}

	// Shared lookup helpers — hot path so prepared + closed over.
	const findBySetNumStmt = sqlite.prepare(
		'SELECT id FROM cards WHERE set_code = ? AND collector_number = ? LIMIT 1'
	);
	const findByNameStmt = sqlite.prepare(
		'SELECT id FROM cards WHERE name = ? ORDER BY released_at DESC LIMIT 1'
	);
	const findByNameAndNumStmt = sqlite.prepare(
		'SELECT id FROM cards WHERE name = ? AND collector_number = ? ORDER BY released_at DESC LIMIT 1'
	);
	const findByCmIdStmt = sqlite.prepare(
		'SELECT id FROM cards WHERE cardmarket_id = ? ORDER BY released_at DESC LIMIT 1'
	);

	const findBySetNum = (set: string, num: string) =>
		findBySetNumStmt.get(set, num) as { id: string } | undefined;
	const findByName = (name: string) =>
		findByNameStmt.get(name) as { id: string } | undefined;
	const findByNameAndNum = (name: string, num: string) =>
		findByNameAndNumStmt.get(name, num) as { id: string } | undefined;
	const findByCmId = (id: number) =>
		findByCmIdStmt.get(id) as { id: string } | undefined;

	let parsed: { rows: PriceRow[]; parseErrors: string[]; parseErrorCount: number };

	if (format === 'text') {
		const text = formData.get('text');
		if (typeof text !== 'string' || !text.trim()) {
			return json({ success: false, message: 'No text provided' }, { status: 400 });
		}
		if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) {
			return json({ success: false, message: 'Text too large (>1 MB)' }, { status: 413 });
		}
		parsed = await parseTextBody(text, findBySetNum, findByName);
	} else if (format === 'cardmarket') {
		const file = formData.get('file');
		if (!(file instanceof File)) {
			return json({ success: false, message: 'No file provided' }, { status: 400 });
		}
		if (file.size > MAX_CSV_BYTES) {
			return json({ success: false, message: 'CSV too large (>5 MB)' }, { status: 413 });
		}
		const text = await file.text();
		parsed = await parseCardmarket(text, findByCmId);
	} else {
		const file = formData.get('file');
		if (!(file instanceof File)) {
			return json({ success: false, message: 'No file provided' }, { status: 400 });
		}
		if (file.size > MAX_XLS_BYTES) {
			return json({ success: false, message: 'XLS too large (>10 MB)' }, { status: 413 });
		}
		const bytes = await file.arrayBuffer();
		parsed = parseCardtrader(bytes, findBySetNum, findByName, findByNameAndNum);
	}

	const { rows, parseErrors, parseErrorCount } = parsed;

	if (rows.length === 0 && parseErrorCount === 0) {
		return json({ success: false, message: 'No price rows found' }, { status: 400 });
	}

	// Apply updates. For each matched card+foil, update all collection_cards
	// rows belonging to this user. Mode controls whether existing non-null
	// purchase_price values are overwritten.
	const updateStmt = mode === 'overwrite'
		? sqlite.prepare(
			`UPDATE collection_cards SET purchase_price = ?
			 WHERE user_id = ? AND card_id = ? AND foil = ?`
		)
		: sqlite.prepare(
			`UPDATE collection_cards SET purchase_price = ?
			 WHERE user_id = ? AND card_id = ? AND foil = ? AND purchase_price IS NULL`
		);

	let updatedRows = 0; // count of collection_cards rows touched
	let matchedCards = 0; // count of price rows that matched a collection entry
	let notInCollection = 0;
	let notMatched = 0;
	const notMatchedLabels: string[] = [];
	const notInCollectionLabels: string[] = [];

	const transaction = sqlite.transaction(() => {
		for (const row of rows) {
			if (!row.cardId) {
				notMatched++;
				if (notMatchedLabels.length < 20) notMatchedLabels.push(row.label);
				continue;
			}
			const result = updateStmt.run(row.priceEur, userId, row.cardId, row.foil);
			if (result.changes > 0) {
				matchedCards++;
				updatedRows += result.changes;
			} else {
				notInCollection++;
				if (notInCollectionLabels.length < 20) notInCollectionLabels.push(row.label);
			}
		}
	});
	transaction();

	priceDataCache.invalidate(userId);

	return json({
		success: true,
		format,
		mode,
		total: rows.length,
		matchedCards,
		updatedRows,
		notInCollection,
		notInCollectionLabels,
		notMatched,
		notMatchedLabels,
		parseErrors,
		parseErrorCount
	});
}
