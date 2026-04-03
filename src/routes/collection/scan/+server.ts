import { json } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';

export async function POST({ request }) {
	const body = await request.json();
	const { query, setCode, collectorNumber } = body;

	const selectFields = `id, name, set_name, set_code, collector_number, image_uri, local_image_path, price_eur, price_eur_foil, rarity`;

	// Search by set code + collector number (most reliable, language-independent)
	if (setCode && collectorNumber) {
		// Try exact collector number
		let results = sqlite
			.prepare(`SELECT ${selectFields} FROM cards WHERE set_code = ? AND collector_number = ?`)
			.all(setCode.toLowerCase(), collectorNumber) as Array<Record<string, unknown>>;

		// Try stripping leading zeros
		if (results.length === 0) {
			const stripped = collectorNumber.replace(/^0+/, '');
			results = sqlite
				.prepare(`SELECT ${selectFields} FROM cards WHERE set_code = ? AND collector_number = ?`)
				.all(setCode.toLowerCase(), stripped) as Array<Record<string, unknown>>;
		}

		// Try with leading zeros
		if (results.length === 0) {
			const padded = collectorNumber.padStart(3, '0');
			results = sqlite
				.prepare(`SELECT ${selectFields} FROM cards WHERE set_code = ? AND collector_number = ?`)
				.all(setCode.toLowerCase(), padded) as Array<Record<string, unknown>>;
		}

		return json({ results, matchType: results.length > 0 ? 'exact' : 'none' });
	}

	// Search by name
	if (!query || query.trim().length < 2) {
		return json({ results: [] });
	}

	const cleaned = query.trim();

	// Try exact match first
	const exact = sqlite
		.prepare(`SELECT ${selectFields} FROM cards WHERE name = ? ORDER BY released_at DESC LIMIT 10`)
		.all(cleaned) as Array<Record<string, unknown>>;

	if (exact.length > 0) {
		return json({ results: exact, matchType: 'exact' });
	}

	// Try LIKE match
	const like = sqlite
		.prepare(`SELECT ${selectFields} FROM cards WHERE name LIKE ? ORDER BY released_at DESC LIMIT 20`)
		.all(`%${cleaned}%`) as Array<Record<string, unknown>>;

	if (like.length > 0) {
		return json({ results: like, matchType: 'like' });
	}

	// Try FTS with each word
	const words = cleaned
		.replace(/['"]/g, '')
		.split(/\s+/)
		.filter((w) => w.length >= 2);

	if (words.length > 0) {
		const ftsQuery = words.map((w) => `"${w}"*`).join(' ');
		try {
			const fts = sqlite
				.prepare(
					`SELECT ${selectFields}
					FROM cards
					WHERE id IN (SELECT card_id FROM cards_fts WHERE cards_fts MATCH ?)
					ORDER BY released_at DESC LIMIT 20`
				)
				.all(ftsQuery) as Array<Record<string, unknown>>;
			return json({ results: fts, matchType: 'fts' });
		} catch {
			// FTS query syntax error
		}
	}

	return json({ results: [], matchType: 'none' });
}
