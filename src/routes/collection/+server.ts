import { json, error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { priceDataCache } from '$lib/server/cache';
import { parseLanguageInput } from '$lib/utils';
import { ensureForeignPrice } from '$lib/server/foreign-prices';
import { getUsdToEurRate } from '$lib/server/exchange-rate';

// Collection rows feed financial calculations and reference cards(id) via a
// foreign key, so the user-supplied payload is validated rather than trusted: an
// unknown cardId would otherwise raise an FK violation (500), and negative/NaN
// quantities or prices would silently corrupt collection totals and profit/loss.
const VALID_CONDITIONS = new Set([
	'near_mint',
	'lightly_played',
	'moderately_played',
	'heavily_played',
	'damaged'
]);
const MAX_QUANTITY = 100000;

function cleanQuantity(raw: unknown): number {
	const n = Math.trunc(Number(raw));
	if (!Number.isFinite(n) || n < 1) return 1;
	return Math.min(n, MAX_QUANTITY);
}
function cleanCondition(raw: unknown): string {
	return typeof raw === 'string' && VALID_CONDITIONS.has(raw) ? raw : 'near_mint';
}
function cleanPurchasePrice(raw: unknown): number | null {
	if (raw === null || raw === undefined || raw === '') return null;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function POST({ request, locals }) {
	if (!locals.user) throw error(401, 'Not authenticated');
	const { cardId, quantity, condition, foil, language, purchasePrice } = await request.json();
	if (typeof cardId !== 'string' || !sqlite.prepare('SELECT 1 FROM cards WHERE id = ?').get(cardId)) {
		throw error(400, 'Unknown card');
	}
	const lang = parseLanguageInput(language);

	sqlite
		.prepare(
			'INSERT INTO collection_cards (user_id, card_id, quantity, condition, foil, language, purchase_price, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
		)
		.run(
			locals.user.id,
			cardId,
			cleanQuantity(quantity),
			cleanCondition(condition),
			foil ? 1 : 0,
			lang,
			cleanPurchasePrice(purchasePrice),
			new Date().toISOString()
		);

	priceDataCache.invalidate(locals.user.id);

	// Best-effort: don't block the response on the Scryfall round-trip; a stale
	// foreign price for a few seconds is fine.
	ensureForeignPrice(cardId, lang).catch(() => {});

	return json({ success: true });
}

export async function PUT({ request, locals }) {
	if (!locals.user) throw error(401, 'Not authenticated');
	const { id, quantity, condition, foil, language, notes, purchasePrice } = await request.json();
	if (!Number.isInteger(id)) throw error(400, 'Invalid id');
	const lang = parseLanguageInput(language);

	const result = sqlite
		.prepare(
			'UPDATE collection_cards SET quantity = ?, condition = ?, foil = ?, language = ?, notes = ?, purchase_price = ? WHERE id = ? AND user_id = ?'
		)
		.run(
			cleanQuantity(quantity),
			cleanCondition(condition),
			foil ? 1 : 0,
			lang,
			typeof notes === 'string' ? notes : null,
			cleanPurchasePrice(purchasePrice),
			id,
			locals.user.id
		);
	if (result.changes === 0) throw error(404, 'Not found');

	priceDataCache.invalidate(locals.user.id);

	const row = sqlite
		.prepare('SELECT card_id FROM collection_cards WHERE id = ? AND user_id = ?')
		.get(id, locals.user.id) as { card_id: string } | undefined;
	if (row) ensureForeignPrice(row.card_id, lang).catch(() => {});

	return json({ success: true });
}

export async function DELETE({ request, locals }) {
	if (!locals.user) throw error(401, 'Not authenticated');
	const { id } = await request.json();
	if (!Number.isInteger(id)) throw error(400, 'Invalid id');
	sqlite
		.prepare(
			'DELETE FROM collection_card_tags WHERE collection_card_id = ? AND collection_card_id IN (SELECT id FROM collection_cards WHERE user_id = ?)'
		)
		.run(id, locals.user.id);
	sqlite.prepare('DELETE FROM collection_cards WHERE id = ? AND user_id = ?').run(id, locals.user.id);
	priceDataCache.invalidate(locals.user.id);
	return json({ success: true });
}

export async function PATCH({ locals }) {
	if (!locals.user) throw error(401, 'Not authenticated');
	const usdToEur = await getUsdToEurRate();

	// Fill missing purchase prices with the same effective current price the UI
	// shows: per-language overlay first, then English, then USD*rate fallback.
	// (Previously this used the English EUR price only, so USD-only and
	// non-English cards were either left unset or recorded at the wrong price.)
	const result = sqlite
		.prepare(
			`UPDATE collection_cards SET purchase_price = (
				SELECT COALESCE(
					CASE WHEN collection_cards.foil = 1 THEN COALESCE(cpl.price_eur_foil, c.price_eur_foil) ELSE COALESCE(cpl.price_eur, c.price_eur) END,
					(CASE WHEN collection_cards.foil = 1 THEN COALESCE(cpl.price_usd_foil, c.price_usd_foil) ELSE COALESCE(cpl.price_usd, c.price_usd) END) * ?
				)
				FROM cards c
				LEFT JOIN card_prices_lang cpl ON cpl.card_id = c.id AND cpl.language = collection_cards.language
				WHERE c.id = collection_cards.card_id
			)
			WHERE purchase_price IS NULL AND user_id = ?`
		)
		.run(usdToEur, locals.user.id);

	priceDataCache.invalidate(locals.user.id);
	return json({ success: true, updated: result.changes });
}
