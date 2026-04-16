import { sqlite } from '$lib/server/db';
import { getUsdToEurRate } from '$lib/server/exchange-rate';
import { redirect } from '@sveltejs/kit';
import { tagsCache } from '$lib/server/cache';

export async function load({ url, locals }) {
	if (!locals.user) throw redirect(302, '/login');
	const userId = locals.user.id;
	const usdToEur = await getUsdToEurRate();

	const tagFilter = url.searchParams.get('tag');
	const search = url.searchParams.get('q') || '';
	const sortBy = url.searchParams.get('sort') || 'added_at';
	const sortDir = url.searchParams.get('dir') || 'desc';
	const page = parseInt(url.searchParams.get('page') || '1');
	const pageSize = 40;
	const offset = (page - 1) * pageSize;

	const conditions: string[] = ['cc.user_id = ?'];
	const params: (string | number)[] = [userId];

	if (search) {
		conditions.push('c.name LIKE ?');
		params.push(`%${search}%`);
	}

	if (tagFilter) {
		conditions.push(`cc.id IN (SELECT collection_card_id FROM collection_card_tags WHERE tag_id = ?)`);
		params.push(parseInt(tagFilter));
	}

	const whereClause = `WHERE ${conditions.join(' AND ')}`;

	const validSorts: Record<string, string> = {
		name: 'c.name',
		added_at: 'cc.added_at',
		price: 'CASE WHEN cc.foil = 1 THEN c.price_eur_foil ELSE c.price_eur END',
		profit: `CASE WHEN cc.purchase_price IS NOT NULL AND cc.purchase_price > 0 THEN
			(COALESCE(
				CASE WHEN cc.foil = 1 THEN c.price_eur_foil ELSE c.price_eur END,
				CASE WHEN cc.foil = 1 THEN c.price_usd_foil ELSE c.price_usd END * ${usdToEur}
			) - cc.purchase_price) / cc.purchase_price * 100
			ELSE NULL END`,
		profit_total: `CASE WHEN cc.purchase_price IS NOT NULL AND cc.purchase_price > 0 THEN
			(COALESCE(
				CASE WHEN cc.foil = 1 THEN c.price_eur_foil ELSE c.price_eur END,
				CASE WHEN cc.foil = 1 THEN c.price_usd_foil ELSE c.price_usd END * ${usdToEur}
			) - cc.purchase_price) * cc.quantity
			ELSE NULL END`,
		quantity: 'cc.quantity',
		set_name: 'c.set_name'
	};
	const orderColumn = validSorts[sortBy] || 'cc.added_at';
	const orderDir = sortDir === 'asc' ? 'ASC' : 'DESC';

	const countResult = sqlite
		.prepare(
			`SELECT COUNT(*) as count FROM collection_cards cc JOIN cards c ON cc.card_id = c.id ${whereClause}`
		)
		.get(...params) as { count: number };

	const items = sqlite
		.prepare(
			`SELECT cc.*, c.name, c.set_name, c.set_code, c.collector_number, c.image_uri, c.local_image_path,
				c.mana_cost, c.type_line, c.rarity, c.price_eur, c.price_eur_foil, c.price_usd, c.price_usd_foil, cc.purchase_price
			FROM collection_cards cc
			JOIN cards c ON cc.card_id = c.id
			${whereClause}
			ORDER BY ${orderColumn} ${orderDir}
			LIMIT ? OFFSET ?`
		)
		.all(...params, pageSize, offset) as Array<Record<string, unknown>>;

	// Get tags for all collection cards in a single batch query (avoids N+1)
	const itemIds = items.map((item) => item.id as number);
	const tagsMap = new Map<number, Array<Record<string, unknown>>>();
	if (itemIds.length > 0) {
		const placeholders = itemIds.map(() => '?').join(',');
		const tagRows = sqlite
			.prepare(
				`SELECT cct.collection_card_id, t.id, t.name, t.color
				FROM collection_card_tags cct
				JOIN tags t ON t.id = cct.tag_id
				WHERE cct.collection_card_id IN (${placeholders})`
			)
			.all(...itemIds) as Array<{ collection_card_id: number; id: number; name: string; color: string }>;
		for (const row of tagRows) {
			if (!tagsMap.has(row.collection_card_id)) tagsMap.set(row.collection_card_id, []);
			tagsMap.get(row.collection_card_id)!.push({ id: row.id, name: row.name, color: row.color });
		}
	}
	const itemsWithTags = items.map((item) => ({
		...item,
		tags: tagsMap.get(item.id as number) || []
	})) as Array<Record<string, unknown> & { tags: Array<Record<string, unknown>> }>;

	// Get the user's tags (cached per-user, short TTL)
	const allTags = tagsCache.get(userId);

	// Get collection stats
	const stats = sqlite
		.prepare(
			`SELECT
				COUNT(*) as uniqueCards,
				COALESCE(SUM(cc.quantity), 0) as totalCards,
				COALESCE(SUM(CASE WHEN cc.foil = 1 THEN c.price_eur_foil ELSE c.price_eur END * cc.quantity), 0) as totalValue
			FROM collection_cards cc JOIN cards c ON cc.card_id = c.id
			WHERE cc.user_id = ?`
		)
		.get(userId) as { uniqueCards: number; totalCards: number; totalValue: number };

	// Load a specific card for edit modal (e.g. from prices page link)
	const editId = url.searchParams.get('edit');
	let editCard: (Record<string, unknown> & { tags: Array<Record<string, unknown>> }) | null = null;
	if (editId) {
		const item = sqlite
			.prepare(
				`SELECT cc.*, c.name, c.set_name, c.set_code, c.collector_number, c.image_uri, c.local_image_path,
					c.mana_cost, c.type_line, c.rarity, c.price_eur, c.price_eur_foil, c.price_usd, c.price_usd_foil, cc.purchase_price
				FROM collection_cards cc
				JOIN cards c ON cc.card_id = c.id
				WHERE cc.id = ? AND cc.user_id = ?`
			)
			.get(parseInt(editId), userId) as Record<string, unknown> | undefined;
		if (item) {
			const cardTags = sqlite
				.prepare('SELECT t.* FROM tags t JOIN collection_card_tags cct ON t.id = cct.tag_id WHERE cct.collection_card_id = ?')
				.all(item.id) as Array<Record<string, unknown>>;
			editCard = { ...item, tags: cardTags };
		}
	}

	return {
		items: itemsWithTags,
		totalItems: countResult.count,
		page,
		pageSize,
		totalPages: Math.ceil(countResult.count / pageSize),
		tags: allTags,
		stats,
		filters: { search, tagFilter, sortBy, sortDir },
		editCard,
		usdToEur
	};
}
