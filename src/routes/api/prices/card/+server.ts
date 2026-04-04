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
			`SELECT MAX(price_eur) as price_eur, MAX(price_eur_foil) as price_eur_foil, MAX(recorded_at) as recorded_at
			 FROM price_history
			 WHERE card_id = ?
			 GROUP BY DATE(recorded_at, CASE WHEN CAST(strftime('%H', recorded_at) AS INTEGER) < 10 THEN '-1 day' ELSE '0 days' END)
			 ORDER BY recorded_at ASC`
		)
		.all(cardId) as Array<{ price_eur: number | null; price_eur_foil: number | null; recorded_at: string }>;

	return json({ card, history });
}
