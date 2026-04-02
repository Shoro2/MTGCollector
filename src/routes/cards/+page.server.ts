import { db, sqlite } from '$lib/server/db';
import { cards } from '$lib/server/schema';
import { sql } from 'drizzle-orm';

export async function load({ url }) {
	const query = url.searchParams.get('q') || '';
	const colors = url.searchParams.getAll('color');
	const colorMode = url.searchParams.get('colorMode') || 'include';
	const type = url.searchParams.get('type') || '';
	const setCode = url.searchParams.get('set') || '';
	const rarity = url.searchParams.get('rarity') || '';
	const cmcMin = url.searchParams.get('cmcMin');
	const cmcMax = url.searchParams.get('cmcMax');
	const legality = url.searchParams.get('legality') || '';
	const page = parseInt(url.searchParams.get('page') || '1');
	const pageSize = 40;
	const offset = (page - 1) * pageSize;

	const conditions: string[] = [];
	const params: (string | number)[] = [];

	// Full-text search
	if (query) {
		conditions.push(`cards.rowid IN (SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?)`);
		// Escape FTS5 special characters and add prefix matching
		const ftsQuery = query
			.replace(/['"]/g, '')
			.split(/\s+/)
			.filter(Boolean)
			.map((term) => `"${term}"*`)
			.join(' ');
		params.push(ftsQuery);
	}

	// Color filter
	if (colors.length > 0) {
		if (colorMode === 'exact') {
			// Exact: card has exactly these colors
			for (const c of colors) {
				conditions.push(`cards.colors LIKE ?`);
				params.push(`%"${c}"%`);
			}
			conditions.push(`json_array_length(cards.colors) = ?`);
			params.push(colors.length);
		} else if (colorMode === 'at_most') {
			// At most: card colors are a subset
			const allColors = ['W', 'U', 'B', 'R', 'G'];
			const excluded = allColors.filter((c) => !colors.includes(c));
			for (const c of excluded) {
				conditions.push(`(cards.colors IS NULL OR cards.colors NOT LIKE ?)`);
				params.push(`%"${c}"%`);
			}
		} else {
			// Include: card has at least these colors
			for (const c of colors) {
				conditions.push(`cards.colors LIKE ?`);
				params.push(`%"${c}"%`);
			}
		}
	}

	// Type filter
	if (type) {
		conditions.push(`cards.type_line LIKE ?`);
		params.push(`%${type}%`);
	}

	// Set filter
	if (setCode) {
		conditions.push(`cards.set_code = ?`);
		params.push(setCode);
	}

	// Rarity filter
	if (rarity) {
		conditions.push(`cards.rarity = ?`);
		params.push(rarity);
	}

	// CMC range
	if (cmcMin) {
		conditions.push(`cards.cmc >= ?`);
		params.push(parseFloat(cmcMin));
	}
	if (cmcMax) {
		conditions.push(`cards.cmc <= ?`);
		params.push(parseFloat(cmcMax));
	}

	// Legality filter
	if (legality) {
		conditions.push(`json_extract(cards.legalities, ?) = 'legal'`);
		params.push(`$.${legality}`);
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

	// Get total count
	const countSql = `SELECT COUNT(*) as count FROM cards ${whereClause}`;
	const countResult = sqlite.prepare(countSql).get(...params) as { count: number };
	const totalCards = countResult.count;

	// Get paginated results
	const resultSql = `SELECT * FROM cards ${whereClause} ORDER BY name ASC LIMIT ? OFFSET ?`;
	const results = sqlite.prepare(resultSql).all(...params, pageSize, offset) as Array<Record<string, unknown>>;

	// Get all unique sets for the filter dropdown
	const sets = sqlite
		.prepare('SELECT DISTINCT set_code, set_name FROM cards ORDER BY set_name ASC')
		.all() as Array<{ set_code: string; set_name: string }>;

	return {
		cards: results,
		totalCards,
		page,
		pageSize,
		totalPages: Math.ceil(totalCards / pageSize),
		filters: { query, colors, colorMode, type, setCode, rarity, cmcMin, cmcMax, legality },
		sets
	};
}
