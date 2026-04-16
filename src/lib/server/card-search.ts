import { sqlite } from './db.js';

const selectFields = `id, name, set_name, set_code, collector_number, image_uri, local_image_path, price_eur, price_eur_foil, price_usd, price_usd_foil, rarity`;

export type CardRow = Record<string, unknown>;
export type SearchResult = { results: CardRow[]; matchType: 'exact' | 'like' | 'fts' | 'none' };

const exactStmt = sqlite.prepare(`SELECT ${selectFields} FROM cards WHERE name = ? ORDER BY released_at DESC LIMIT 10`);
const likeStmt = sqlite.prepare(`SELECT ${selectFields} FROM cards WHERE name LIKE ? ORDER BY released_at DESC LIMIT 20`);
const ftsStmt = sqlite.prepare(
	`SELECT ${selectFields}
	FROM cards
	WHERE id IN (SELECT card_id FROM cards_fts WHERE cards_fts MATCH ?)
	ORDER BY released_at DESC LIMIT 20`
);
const setNumStmt = sqlite.prepare(`SELECT ${selectFields} FROM cards WHERE set_code = ? AND collector_number = ?`);

/**
 * Resolve a card by its (probably OCR'd) name. Tries cheapest paths first:
 * exact match → FTS5 prefix match (indexed) → substring LIKE (full scan,
 * last-resort fallback).
 */
export function searchByName(query: string): SearchResult {
	const cleaned = query.trim();
	if (cleaned.length < 2) return { results: [], matchType: 'none' };

	const exact = exactStmt.all(cleaned) as CardRow[];
	if (exact.length > 0) return { results: exact, matchType: 'exact' };

	const words = cleaned
		.replace(/['"]/g, '')
		.split(/\s+/)
		.filter((w) => w.length >= 2);
	if (words.length > 0) {
		const ftsQuery = words.map((w) => `"${w}"*`).join(' ');
		try {
			const fts = ftsStmt.all(ftsQuery) as CardRow[];
			if (fts.length > 0) return { results: fts, matchType: 'fts' };
		} catch { /* FTS syntax error — fall through to LIKE */ }
	}

	const like = likeStmt.all(`%${cleaned}%`) as CardRow[];
	if (like.length > 0) return { results: like, matchType: 'like' };

	return { results: [], matchType: 'none' };
}

/**
 * Resolve a card by set code + collector number. Tries the raw number, then
 * zero-stripped, then zero-padded to 3 digits to tolerate the variations
 * seen in OCR output and print runs.
 */
export function searchBySetNumber(setCode: string, collectorNumber: string): SearchResult {
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
