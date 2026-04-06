import { sqlite } from '$lib/server/db';
import { json } from '@sveltejs/kit';

export async function GET({ url, locals }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const cardId = url.searchParams.get('id');
	if (!cardId) return json({ error: 'Missing card id' }, { status: 400 });

	const card = sqlite.prepare('SELECT id, name, set_name FROM cards WHERE id = ?').get(cardId) as { id: string; name: string; set_name: string } | null;
	if (!card) return json({ error: 'Card not found' }, { status: 404 });

	const history = sqlite
		.prepare(
			`WITH dp AS (
				SELECT price_eur, price_eur_foil,
					DATE(recorded_at, CASE WHEN CAST(strftime('%H', recorded_at) AS INTEGER) < 10 THEN '-1 day' ELSE '0 days' END) as effective_date,
					ROW_NUMBER() OVER (
						PARTITION BY DATE(recorded_at, CASE WHEN CAST(strftime('%H', recorded_at) AS INTEGER) < 10 THEN '-1 day' ELSE '0 days' END)
						ORDER BY recorded_at DESC
					) as rn
				FROM price_history WHERE card_id = ?
			)
			SELECT price_eur, price_eur_foil, effective_date as recorded_at
			FROM dp WHERE rn = 1
			ORDER BY effective_date ASC`
		)
		.all(cardId) as Array<{ price_eur: number | null; price_eur_foil: number | null; recorded_at: string }>;

	return json({ card, history }, {
		headers: {
			'Cache-Control': 'private, max-age=3600, stale-while-revalidate=86400'
		}
	});
}
