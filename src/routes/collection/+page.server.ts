import { sqlite } from '$lib/server/db';
import { redirect } from '@sveltejs/kit';

export async function load({ url, locals }) {
	if (!locals.user) throw redirect(302, '/login');
	const userId = locals.user.id;

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

	// Get tags for each collection card
	const itemsWithTags = items.map((item) => {
		const cardTags = sqlite
			.prepare(
				`SELECT t.* FROM tags t JOIN collection_card_tags cct ON t.id = cct.tag_id WHERE cct.collection_card_id = ?`
			)
			.all(item.id) as Array<Record<string, unknown>>;
		return { ...item, tags: cardTags } as Record<string, unknown> & { tags: Array<Record<string, unknown>> };
	});

	// Get all tags
	const allTags = sqlite.prepare('SELECT * FROM tags ORDER BY name').all() as Array<Record<string, unknown>>;

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
		editCard
	};
}
