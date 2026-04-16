import { db, sqlite } from '$lib/server/db';
import { cards } from '$lib/server/schema';
import { sql } from 'drizzle-orm';
import { setsCache } from '$lib/server/cache';

export async function load({ url, locals }) {
	const query = url.searchParams.get('q') || '';
	const colors = url.searchParams.getAll('color');
	const colorMode = url.searchParams.get('colorMode') || 'include';
	const type = url.searchParams.get('type') || '';
	const setCode = url.searchParams.get('set') || '';
	const rarity = url.searchParams.get('rarity') || '';
	const cmcMin = url.searchParams.get('cmcMin');
	const cmcMax = url.searchParams.get('cmcMax');
	const legality = url.searchParams.get('legality') || '';
	const sortBy = url.searchParams.get('sort') || 'name';
	const sortDir = url.searchParams.get('dir') || 'asc';
	const unique = url.searchParams.get('unique') === '1';
	const page = parseInt(url.searchParams.get('page') || '1');
	const validPageSizes = [40, 75, 100, 200];
	const pageSizeParam = parseInt(url.searchParams.get('pageSize') || '40');
	const pageSize = validPageSizes.includes(pageSizeParam) ? pageSizeParam : 40;
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

	// Color filter (using json_each for proper JSON array querying)
	if (colors.length > 0) {
		if (colorMode === 'exact') {
			// Exact: card has exactly these colors
			for (const c of colors) {
				conditions.push(`EXISTS (SELECT 1 FROM json_each(cards.colors) WHERE json_each.value = ?)`);
				params.push(c);
			}
			conditions.push(`json_array_length(cards.colors) = ?`);
			params.push(colors.length);
		} else if (colorMode === 'at_most') {
			// At most: card colors are a subset
			const allColors = ['W', 'U', 'B', 'R', 'G'];
			const excluded = allColors.filter((c) => !colors.includes(c));
			for (const c of excluded) {
				conditions.push(`NOT EXISTS (SELECT 1 FROM json_each(cards.colors) WHERE json_each.value = ?)`);
				params.push(c);
			}
		} else {
			// Include: card has at least these colors
			for (const c of colors) {
				conditions.push(`EXISTS (SELECT 1 FROM json_each(cards.colors) WHERE json_each.value = ?)`);
				params.push(c);
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

	// Unique mode: only show newest printing per oracle_id
	const uniqueJoin = unique
		? `INNER JOIN (SELECT MAX(id) as id FROM cards GROUP BY oracle_id) unique_cards ON cards.id = unique_cards.id`
		: '';

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

	// Get total count
	const countSql = `SELECT COUNT(*) as count FROM cards ${uniqueJoin} ${whereClause}`;
	const countResult = sqlite.prepare(countSql).get(...params) as { count: number };
	const totalCards = countResult.count;

	// Sort
	const validSorts: Record<string, string> = {
		name: 'cards.name',
		price: 'cards.price_eur',
		cmc: 'cards.cmc',
		rarity: "CASE cards.rarity WHEN 'mythic' THEN 4 WHEN 'rare' THEN 3 WHEN 'uncommon' THEN 2 ELSE 1 END",
		set: 'cards.set_name',
		released: 'cards.released_at',
		power: 'CAST(cards.power AS REAL)',
		toughness: 'CAST(cards.toughness AS REAL)'
	};
	const orderColumn = validSorts[sortBy] || 'cards.name';
	const orderDir = sortDir === 'desc' ? 'DESC' : 'ASC';
	const nullHandling = ['price', 'power', 'toughness'].includes(sortBy) ? `NULLS LAST` : '';

	// Get paginated results
	const resultSql = `SELECT cards.id, cards.name, cards.set_code, cards.set_name, cards.rarity, cards.image_uri, cards.local_image_path, cards.price_eur, cards.price_usd, cards.mana_cost, cards.cmc, cards.power, cards.toughness FROM cards ${uniqueJoin} ${whereClause} ORDER BY ${orderColumn} ${orderDir} ${nullHandling} LIMIT ? OFFSET ?`;
	const results = sqlite.prepare(resultSql).all(...params, pageSize, offset) as Array<Record<string, unknown>>;

	// Get all unique sets for the filter dropdown (cached, changes only on import)
	const sets = setsCache.get();

	// Get card IDs in collection/wishlist for marking (only for current page)
	const userId = locals?.user?.id;
	const pageCardIds = results.map((r) => r.id as string);
	let collectedCardIds = new Set<string>();
	let wishlistCardIds = new Set<string>();

	if (userId && pageCardIds.length > 0) {
		const placeholders = pageCardIds.map(() => '?').join(',');
		const collectedRows = sqlite
			.prepare(`SELECT DISTINCT card_id FROM collection_cards WHERE user_id = ? AND card_id IN (${placeholders})`)
			.all(userId, ...pageCardIds) as Array<{ card_id: string }>;
		collectedCardIds = new Set(collectedRows.map((r) => r.card_id));

		const wishlistRows = sqlite
			.prepare(`SELECT DISTINCT card_id FROM wishlist_cards WHERE user_id = ? AND card_id IN (${placeholders})`)
			.all(userId, ...pageCardIds) as Array<{ card_id: string }>;
		wishlistCardIds = new Set(wishlistRows.map((r) => r.card_id));
	}

	return {
		cards: results,
		collectedCardIds: [...collectedCardIds],
		wishlistCardIds: [...wishlistCardIds],
		totalCards,
		page,
		pageSize,
		totalPages: Math.ceil(totalCards / pageSize),
		filters: { query, colors, colorMode, type, setCode, rarity, cmcMin, cmcMax, legality, sortBy, sortDir, unique, pageSize },
		sets
	};
}
