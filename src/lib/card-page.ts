/** Pure helpers for the card page (/cards/<slug>): one card, all of its printings. */
import { formatPrice } from './utils';

export type PrintingSummary = {
	id: string;
	set_code: string;
	set_name: string;
	collector_number: string;
	rarity: string;
	released_at: string | null;
	image_uri: string | null;
	local_image_path: string | null;
	price_eur: number | null;
	price_usd: number | null;
	price_eur_foil: number | null;
	price_usd_foil: number | null;
};

const has = (v: number | null | undefined): v is number => v !== null && v !== undefined;

/**
 * The printing whose image and rules represent the card: one with an image and a
 * non-foil price (a regular paper printing), newest first. Foil-only promos and
 * printings without an image only stand in when nothing else exists.
 */
export function pickMainPrinting<T extends PrintingSummary>(printings: T[]): T {
	const rank = (x: T) => (x.image_uri || x.local_image_path ? 0 : 2) + (has(x.price_eur) || has(x.price_usd) ? 0 : 1);
	return [...printings].sort((a, b) => rank(a) - rank(b) || (b.released_at ?? '').localeCompare(a.released_at ?? '') || a.id.localeCompare(b.id))[0];
}

/** Lowest list price over all printings: EUR non-foil, else EUR foil, else USD. */
export function cheapestPrice(printings: PrintingSummary[]): { text: string; foil: boolean } | null {
	const min = (values: Array<number | null>) => {
		const v = values.filter(has);
		return v.length ? Math.min(...v) : null;
	};
	const eur = min(printings.map((x) => x.price_eur));
	if (eur !== null) return { text: formatPrice(eur), foil: false };
	const eurFoil = min(printings.map((x) => x.price_eur_foil));
	if (eurFoil !== null) return { text: formatPrice(eurFoil), foil: true };
	const usd = min(printings.map((x) => x.price_usd));
	if (usd !== null) return { text: formatPrice(null, usd), foil: false };
	const usdFoil = min(printings.map((x) => x.price_usd_foil));
	return usdFoil !== null ? { text: formatPrice(null, usdFoil), foil: true } : null;
}

export function cardPageMeta(card: { name: string; type_line: string | null }, printings: PrintingSummary[]) {
	const cheapest = cheapestPrice(printings);
	const count = `${printings.length} printing${printings.length === 1 ? '' : 's'}`;
	const type = card.type_line ? ` (${card.type_line})` : '';
	return {
		title: `${card.name} – Price, Printings & Rules`,
		description: `${card.name}${type}: ${count}${cheapest ? `, from ${cheapest.text}` : ''}. Compare the price of every printing, read the rules text and check format legality.`
	};
}
