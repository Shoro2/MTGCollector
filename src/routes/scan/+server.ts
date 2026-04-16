import { json } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';

const selectFields = `id, name, set_name, set_code, collector_number, image_uri, local_image_path, price_eur, price_eur_foil, price_usd, price_usd_foil, rarity`;

type CardRow = Record<string, unknown>;
type SearchResult = { results: CardRow[]; matchType: 'exact' | 'like' | 'fts' | 'none' };

const exactStmt = sqlite.prepare(`SELECT ${selectFields} FROM cards WHERE name = ? ORDER BY released_at DESC LIMIT 10`);
const likeStmt = sqlite.prepare(`SELECT ${selectFields} FROM cards WHERE name LIKE ? ORDER BY released_at DESC LIMIT 20`);
const ftsStmt = sqlite.prepare(
	`SELECT ${selectFields}
	FROM cards
	WHERE id IN (SELECT card_id FROM cards_fts WHERE cards_fts MATCH ?)
	ORDER BY released_at DESC LIMIT 20`
);
const setNumStmt = sqlite.prepare(`SELECT ${selectFields} FROM cards WHERE set_code = ? AND collector_number = ?`);

function searchByName(query: string): SearchResult {
	const cleaned = query.trim();
	if (cleaned.length < 2) return { results: [], matchType: 'none' };

	const exact = exactStmt.all(cleaned) as CardRow[];
	if (exact.length > 0) return { results: exact, matchType: 'exact' };

	const like = likeStmt.all(`%${cleaned}%`) as CardRow[];
	if (like.length > 0) return { results: like, matchType: 'like' };

	const words = cleaned
		.replace(/['"]/g, '')
		.split(/\s+/)
		.filter((w) => w.length >= 2);
	if (words.length === 0) return { results: [], matchType: 'none' };

	const ftsQuery = words.map((w) => `"${w}"*`).join(' ');
	try {
		const fts = ftsStmt.all(ftsQuery) as CardRow[];
		return { results: fts, matchType: fts.length > 0 ? 'fts' : 'none' };
	} catch {
		return { results: [], matchType: 'none' };
	}
}

function searchBySetNumber(setCode: string, collectorNumber: string): SearchResult {
	const lc = setCode.toLowerCase();
	let results = setNumStmt.all(lc, collectorNumber) as CardRow[];
	if (results.length === 0) {
		const stripped = collectorNumber.replace(/^0+/, '');
		if (stripped !== collectorNumber) results = setNumStmt.all(lc, stripped) as CardRow[];
	}
	if (results.length === 0) {
		const padded = collectorNumber.padStart(3, '0');
		if (padded !== collectorNumber) results = setNumStmt.all(lc, padded) as CardRow[];
	}
	return { results, matchType: results.length > 0 ? 'exact' : 'none' };
}

export async function POST({ request }) {
	const body = await request.json();

	// Batch form: { queries: string[] } → { batch: SearchResult[] }
	// The DB lookups are all in-process reads, so we run them synchronously
	// in the same handler rather than round-tripping per card from the client.
	if (Array.isArray(body?.queries)) {
		const queries = (body.queries as unknown[])
			.filter((q): q is string => typeof q === 'string')
			.slice(0, 50); // cap to avoid abuse
		const batch = queries.map((q) => ({ query: q, ...searchByName(q) }));
		return json({ batch });
	}

	const { query, setCode, collectorNumber } = body;

	if (setCode && collectorNumber) {
		return json(searchBySetNumber(String(setCode), String(collectorNumber)));
	}

	if (!query || typeof query !== 'string') {
		return json({ results: [], matchType: 'none' });
	}

	return json(searchByName(query));
}
