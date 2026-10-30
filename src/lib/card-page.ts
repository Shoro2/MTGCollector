/** Pure helpers for the card page (/cards/<slug>): one card, all of its printings. */
import { formatMoney, type Currency } from './currency';

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
	/** Scryfall availability: 1 paper, 0 digital-only (Arena, MTGO), null unknown. */
	is_paper?: number | null;
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

/**
 * Lowest list price over all printings: the currency's own market non-foil, then foil,
 * then the other market (EUR first for search snippets and visitors; a signed-in user
 * may pick USD in /settings).
 */
export function cheapestPrice(printings: PrintingSummary[], currency: Currency = 'EUR'): { text: string; foil: boolean } | null {
	const min = (values: Array<number | null>) => {
		const v = values.filter(has);
		return v.length ? Math.min(...v) : null;
	};
	const other: Currency = currency === 'USD' ? 'EUR' : 'USD';
	const column = (c: Currency, foil: boolean) => (x: PrintingSummary) =>
		c === 'USD' ? (foil ? x.price_usd_foil : x.price_usd) : foil ? x.price_eur_foil : x.price_eur;
	for (const [c, foil] of [[currency, false], [currency, true], [other, false], [other, true]] as const) {
		const lowest = min(printings.map(column(c, foil)));
		if (lowest !== null) return { text: formatMoney(lowest, c), foil };
	}
	return null;
}

// Search results cut titles and snippets to the device width: keep the facts within these.
export const TITLE_MAX = 60;
export const DESCRIPTION_MAX = 155;

/** Cut at a word boundary and end with an ellipsis, within `max` characters. */
export function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = text.slice(0, max - 1);
	const whole = /\s/.test(text[max - 1]) ? head : head.replace(/\s+\S*$/, '');
	return whole.replace(/[\s,;:.—–-]+$/, '') + '…';
}

/**
 * Title and description for the search snippet: the facts a searcher wants first (lowest
 * price and printing count), never a price the card does not have. Digital-only cards
 * (Alchemy, MTGO) never get one, so their title says what they are instead.
 * Owner rule for visitor-facing copy: no dashes. Type lines get commas
 * ("Creature, Human"), ability words and modes a colon ("Landfall: Whenever").
 */
export function cardPageMeta(
	card: { name: string; type_line: string | null; oracle_text?: string | null; set_name?: string | null },
	printings: PrintingSummary[]
) {
	const { name, set_name: set } = card;
	const cheapest = cheapestPrice(printings);
	const count = `${printings.length} printing${printings.length === 1 ? '' : 's'}`;
	const digital = printings.length > 0 && printings.every((x) => x.is_paper === 0);
	let titles: string[], facts: string;
	if (cheapest) {
		titles = [`${name}: MTG price from ${cheapest.text}`, `${name}: price from ${cheapest.text}`];
		if (printings.length > 1) titles.unshift(`${titles[0]}, ${count}`);
		facts = `${count} from ${cheapest.text}${cheapest.foil ? ' (foil)' : ''} with price history.`;
	} else if (digital) {
		titles = [...(set ? [`${name}: digital MTG card, ${set}`] : []), `${name}: digital MTG card`];
		facts = `digital card${set ? ` from ${set}` : ''}.`;
	} else {
		titles = [...(set ? [`${name}: MTG card, ${set}`] : []), `${name}: MTG card`];
		facts = `${count}, no price yet.`;
	}
	const type = card.type_line?.replace(/\s*[—–]\s*/g, ', ');
	const lead = `${name}${type ? ` (${type})` : ''}: ${facts}`;
	const rules = (card.oracle_text ?? '').replace(/\s+/g, ' ').replace(/\s*[—–]\s*/g, ': ').trim();
	const room = DESCRIPTION_MAX - lead.length - 1;
	return {
		title: titles.find((title) => title.length <= TITLE_MAX) ?? name,
		description: rules && room >= 20 ? `${lead} ${clip(rules, room)}` : clip(lead, DESCRIPTION_MAX)
	};
}
