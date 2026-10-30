import { sqlite } from '$lib/server/db';
import { getCardPriceHistory } from '$lib/server/price-data';
import { json } from '@sveltejs/kit';

export async function GET({ url, locals }) {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const cardId = url.searchParams.get('id');
	const lang = url.searchParams.get('lang') || 'en';
	if (!cardId) return json({ error: 'Missing card id' }, { status: 400 });

	const card = sqlite.prepare('SELECT id, name, set_name FROM cards WHERE id = ?').get(cardId) as { id: string; name: string; set_name: string } | null;
	if (!card) return json({ error: 'Card not found' }, { status: 404 });

	// Use the canonical UTC snapshot day for every price chart. The fallback flag
	// follows the display currency: a German copy without a German USD price is
	// estimated from the English one in dollars.
	const history = getCardPriceHistory(sqlite, cardId, lang, locals.user.currency);

	return json({ card, history, fallbackUsed: history.some(row => row.estimated) }, {
		headers: {
			'Cache-Control': 'private, no-store'
		}
	});
}
