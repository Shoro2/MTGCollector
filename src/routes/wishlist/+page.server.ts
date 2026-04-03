import { sqlite } from '$lib/server/db';
import { redirect } from '@sveltejs/kit';

export async function load({ url, locals }) {
	if (!locals.user) throw redirect(302, '/login');
	const userId = locals.user.id;

	const search = url.searchParams.get('q') || '';
	const sortBy = url.searchParams.get('sort') || 'added_at';
	const sortDir = url.searchParams.get('dir') || 'desc';

	const conditions: string[] = ['wc.user_id = ?'];
	const params: (string | number)[] = [userId];

	if (search) {
		conditions.push('c.name LIKE ?');
		params.push(`%${search}%`);
	}

	const whereClause = `WHERE ${conditions.join(' AND ')}`;

	const validSorts: Record<string, string> = {
		name: 'c.name',
		added_at: 'wc.added_at',
		price: 'CASE WHEN c.price_eur IS NOT NULL THEN c.price_eur ELSE c.price_usd END',
		priority: 'wc.priority',
		set_name: 'c.set_name'
	};
	const orderColumn = validSorts[sortBy] || 'wc.added_at';
	const orderDir = sortDir === 'asc' ? 'ASC' : 'DESC';

	const items = sqlite
		.prepare(
			`SELECT wc.id, wc.priority, wc.notes, wc.added_at as wishlist_added_at,
				c.id as card_id, c.name, c.set_name, c.set_code, c.collector_number,
				c.image_uri, c.local_image_path, c.mana_cost, c.type_line, c.rarity,
				c.price_eur, c.price_eur_foil, c.price_usd, c.price_usd_foil
			FROM wishlist_cards wc
			JOIN cards c ON wc.card_id = c.id
			${whereClause}
			ORDER BY ${orderColumn} ${orderDir}`
		)
		.all(...params) as Array<Record<string, unknown>>;

	// Check which wishlist cards are already in collection
	const collectedRows = sqlite
		.prepare('SELECT DISTINCT card_id FROM collection_cards WHERE user_id = ?')
		.all(userId) as Array<{ card_id: string }>;
	const collectedCardIds = new Set(collectedRows.map(r => r.card_id));

	return {
		items,
		collectedCardIds: [...collectedCardIds],
		filters: { search, sortBy, sortDir }
	};
}
