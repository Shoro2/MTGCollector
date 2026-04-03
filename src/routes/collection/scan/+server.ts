import { json } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';

export async function POST({ request }) {
	const { query } = await request.json();

	if (!query || query.trim().length < 2) {
		return json({ results: [] });
	}

	const cleaned = query.trim();

	// Try exact match first
	const exact = sqlite
		.prepare(
			`SELECT id, name, set_name, set_code, collector_number, image_uri, local_image_path, price_eur, price_eur_foil, rarity
			FROM cards WHERE name = ? ORDER BY released_at DESC LIMIT 10`
		)
		.all(cleaned) as Array<Record<string, unknown>>;

	if (exact.length > 0) {
		return json({ results: exact, matchType: 'exact' });
	}

	// Try LIKE match
	const like = sqlite
		.prepare(
			`SELECT id, name, set_name, set_code, collector_number, image_uri, local_image_path, price_eur, price_eur_foil, rarity
			FROM cards WHERE name LIKE ? ORDER BY released_at DESC LIMIT 20`
		)
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
					`SELECT c.id, c.name, c.set_name, c.set_code, c.collector_number, c.image_uri, c.local_image_path, c.price_eur, c.price_eur_foil, c.rarity
					FROM cards c
					WHERE c.id IN (SELECT card_id FROM cards_fts WHERE cards_fts MATCH ?)
					ORDER BY c.released_at DESC LIMIT 20`
				)
				.all(ftsQuery) as Array<Record<string, unknown>>;
			return json({ results: fts, matchType: 'fts' });
		} catch {
			// FTS query syntax error, fall through
		}
	}

	return json({ results: [], matchType: 'none' });
}
