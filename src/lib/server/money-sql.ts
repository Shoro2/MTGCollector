import type { Currency } from '../currency.js';

// SQL expressions for amounts in the user's display currency (src/lib/currency.ts),
// over `collection_cards cc JOIN cards c LEFT JOIN card_prices_lang cpl`. Both read
// the named parameter @rate (USD -> EUR); the currency only picks between two fixed
// strings, so no user input reaches the SQL text.

const pick = (column: string) =>
	`CASE WHEN cc.foil = 1 THEN COALESCE(cpl.${column}_foil, c.${column}_foil) ELSE COALESCE(cpl.${column}, c.${column}) END`;

/** One copy's market price in its finish and language: the currency's own market first, else the other one converted. */
export function marketPriceSql(currency: Currency): string {
	return currency === 'USD'
		? `COALESCE(${pick('price_usd')}, ${pick('price_eur')} / @rate)`
		: `COALESCE(${pick('price_eur')}, ${pick('price_usd')} * @rate)`;
}

/** One copy's purchase price, converted when it was entered in the other currency. */
export function purchasePriceSql(currency: Currency): string {
	return currency === 'USD'
		? `CASE WHEN cc.purchase_currency = 'USD' THEN cc.purchase_price ELSE cc.purchase_price / @rate END`
		: `CASE WHEN cc.purchase_currency = 'USD' THEN cc.purchase_price * @rate ELSE cc.purchase_price END`;
}
