// The display currency a signed-in user picks in /settings (users.currency):
// euros show Cardmarket prices (Scryfall's `eur`), US dollars show TCGplayer
// prices (Scryfall's `usd`). Pure functions, shared by server and pages.
//
// The rules, so the numbers stay honest in both currencies:
// - A single card's price is shown in its own market's currency. When a
//   printing has no price in the chosen currency, the other market's price is
//   shown with its own symbol, never converted (a "€0.45" in dollar mode says
//   that TCGplayer has no price).
// - Totals (collection value, deck value, profit/loss) need one currency, so a
//   price that only exists in the other currency is converted at the day's
//   USD->EUR rate, as before for euros.
// - A purchase price is stored with its own currency (collection_cards.
//   purchase_currency) and converted only when it differs from the display
//   currency.

export const CURRENCIES = ['EUR', 'USD'] as const;
export type Currency = (typeof CURRENCIES)[number];
export const DEFAULT_CURRENCY: Currency = 'EUR';

export function isCurrency(value: unknown): value is Currency {
	return value === 'EUR' || value === 'USD';
}

/** A stored or submitted currency, EUR for anything unknown. */
export function parseCurrency(value: unknown): Currency {
	const upper = typeof value === 'string' ? value.trim().toUpperCase() : value;
	return isCurrency(upper) ? upper : DEFAULT_CURRENCY;
}

export function currencySymbol(currency: Currency): string {
	return currency === 'USD' ? '$' : '€';
}

/** The market whose prices a currency shows, for labels. */
export function currencyMarket(currency: Currency): string {
	return currency === 'USD' ? 'TCGplayer' : 'Cardmarket';
}

/** Converts an amount between the two currencies; `usdToEur` is the day's rate. */
export function convertMoney(amount: number, from: Currency, to: Currency, usdToEur: number): number {
	if (from === to) return amount;
	return from === 'USD' ? amount * usdToEur : amount / usdToEur;
}

/**
 * One copy's market price in `currency`: the price of that currency's market, else
 * the other market's price converted at the rate. Null when neither exists (a gap,
 * never zero).
 */
export function quoteIn(eur: number | null | undefined, usd: number | null | undefined, currency: Currency, usdToEur: number): number | null {
	const own = currency === 'USD' ? usd : eur;
	if (own != null) return own;
	const other = currency === 'USD' ? eur : usd;
	return other == null ? null : convertMoney(other, currency === 'USD' ? 'EUR' : 'USD', currency, usdToEur);
}

/** A purchase price in `currency`. Null stays null. */
export function costIn(price: number | null | undefined, priceCurrency: unknown, currency: Currency, usdToEur: number): number | null {
	return price == null ? null : convertMoney(price, parseCurrency(priceCurrency), currency, usdToEur);
}

const grouped = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** €1.50 / $1.50, as list prices have always been written. */
export function formatMoney(amount: number | null | undefined, currency: Currency): string {
	if (amount == null || !Number.isFinite(amount)) return '-';
	return `${currencySymbol(currency)}${amount.toFixed(2)}`;
}

/** €1,248.30 / $1,248.30: grouped thousands for dashboard totals. */
export function formatMoneyGrouped(amount: number, currency: Currency): string {
	return `${currencySymbol(currency)}${grouped.format(amount)}`;
}

/**
 * A printing's price in its own market's currency: the chosen currency's price,
 * otherwise the other one with its own symbol (never converted). "-" without either.
 */
export function formatQuote(eur: number | null | undefined, usd: number | null | undefined, currency: Currency): string {
	const [first, second] = currency === 'USD'
		? [{ v: usd, c: 'USD' as const }, { v: eur, c: 'EUR' as const }]
		: [{ v: eur, c: 'EUR' as const }, { v: usd, c: 'USD' as const }];
	if (first.v != null) return formatMoney(first.v, first.c);
	if (second.v != null) return formatMoney(second.v, second.c);
	return '-';
}

function trimZeros(text: string): string {
	return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

/** A tick label that stays short on a narrow y axis: €950, $1.5k, €-12k. */
export function compactMoney(value: number | string, currency: Currency): string {
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n)) return String(value);
	const symbol = currencySymbol(currency);
	const abs = Math.abs(n);
	if (abs >= 1000) {
		const thousands = n / 1000;
		const digits = abs >= 10000 || Number.isInteger(thousands) ? 0 : 1;
		return `${symbol}${trimZeros(thousands.toFixed(digits))}k`;
	}
	if (abs === 0) return `${symbol}0`;
	return `${symbol}${trimZeros(n.toFixed(abs >= 10 ? 0 : 2))}`;
}
