import { sqlite } from './db';

// Scryfall returns foreign-language prints under the same set+collector_number
// but with a different UUID. We don't import those rows; we only want their
// price fields, keyed by the *English* card_id + language pair.

interface ScryfallCard {
	prices?: {
		eur?: string | null;
		eur_foil?: string | null;
		usd?: string | null;
		usd_foil?: string | null;
	};
}

const findCardLookup = sqlite.prepare(
	'SELECT set_code, collector_number FROM cards WHERE id = ?'
);

const hasForeignRow = sqlite.prepare(
	'SELECT 1 FROM card_prices_lang WHERE card_id = ? AND language = ?'
);

const upsertForeignRow = sqlite.prepare(
	`INSERT INTO card_prices_lang (card_id, language, price_eur, price_eur_foil, price_usd, price_usd_foil, last_updated)
	 VALUES (?, ?, ?, ?, ?, ?, ?)
	 ON CONFLICT(card_id, language) DO UPDATE SET
		price_eur = excluded.price_eur,
		price_eur_foil = excluded.price_eur_foil,
		price_usd = excluded.price_usd,
		price_usd_foil = excluded.price_usd_foil,
		last_updated = excluded.last_updated`
);

function parsePrice(v: string | null | undefined): number | null {
	if (!v) return null;
	const n = parseFloat(v);
	return isNaN(n) ? null : n;
}

// Looks up the foreign printing on Scryfall. Stores its prices in
// card_prices_lang regardless of whether they're populated, so we don't
// hammer the API on every save when a printing has no foreign price data
// yet. Callers should treat any error as non-fatal — the collection card
// is saved either way; the price just stays unknown until the next try.
export async function ensureForeignPrice(cardId: string, language: string): Promise<void> {
	if (!language || language === 'en') return;
	if (hasForeignRow.get(cardId, language)) return;

	const card = findCardLookup.get(cardId) as
		| { set_code: string | null; collector_number: string | null }
		| undefined;
	if (!card?.set_code || !card.collector_number) return;

	const url = `https://api.scryfall.com/cards/${encodeURIComponent(card.set_code)}/${encodeURIComponent(card.collector_number)}/${encodeURIComponent(language)}`;
	let foreign: ScryfallCard | null = null;
	try {
		const res = await fetch(url);
		if (res.ok) {
			foreign = (await res.json()) as ScryfallCard;
		} else if (res.status === 404) {
			// Card doesn't exist in this language — store an empty row so we
			// don't retry daily.
			upsertForeignRow.run(cardId, language, null, null, null, null, new Date().toISOString());
			return;
		} else {
			// Other error (rate limit, server error) — retry next time.
			return;
		}
	} catch {
		// Network hiccup — leave the row unwritten so we retry on next save.
		return;
	}

	const prices = foreign?.prices;
	upsertForeignRow.run(
		cardId,
		language,
		parsePrice(prices?.eur),
		parsePrice(prices?.eur_foil),
		parsePrice(prices?.usd),
		parsePrice(prices?.usd_foil),
		new Date().toISOString()
	);
}

// Sequential helper for bulk operations (CSV import). Throttles ~5 req/s to
// stay under Scryfall's documented 10 req/s limit with margin.
export async function ensureForeignPricesSequential(
	pairs: Array<{ cardId: string; language: string }>
): Promise<void> {
	const seen = new Set<string>();
	for (const { cardId, language } of pairs) {
		if (!language || language === 'en') continue;
		const key = `${cardId}|${language}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (hasForeignRow.get(cardId, language)) continue;

		await ensureForeignPrice(cardId, language);
		await new Promise((r) => setTimeout(r, 200));
	}
}
