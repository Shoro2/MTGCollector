/**
 * Search-engine rules for decks (owner decision 2026-10-29: public decks may be indexed).
 * Pure and unit-tested; the sitemap query in server/decks.ts applies the same rule in SQL.
 *
 * A deck page is indexable only when the deck is public, not hidden after reports, and holds
 * at least INDEX_MIN_CARDS cards in the command zone and main deck. Private decks are 404 for
 * everybody else, unlisted decks are only for whoever has the link, and a handful of cards
 * is a deck being started, not a page worth a search result.
 */
import { clip, DESCRIPTION_MAX, TITLE_MAX } from './card-page';
import { SITE_URL } from './seo';
import { formatPrice } from './utils';
import type { Visibility } from './deck';

/** Cards in command zone + main deck a public deck needs before search engines may index it. */
export const INDEX_MIN_CARDS = 40;

export function deckIndexable(deck: { visibility: Visibility; hidden: boolean; cards: number }): boolean {
	return deck.visibility === 'public' && !deck.hidden && deck.cards >= INDEX_MIN_CARDS;
}

/** Canonical URL of a deck page: without the view parameters (group, sort). */
export const deckPageUrl = (id: string) => `${SITE_URL}/decks/${id}`;

const COLOR_NAMES: Record<string, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

/** "White", "White and Blue", "White, Blue and Black"; no colors is "colorless". */
export function colorWords(colors: string[]): string {
	const names = colors.map((c) => COLOR_NAMES[c]).filter(Boolean);
	if (!names.length) return 'colorless';
	return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

export type DeckMetaInput = {
	name: string;
	formatLabel: string;
	/** "A & B" for partners; empty without a command zone. */
	commander: string;
	author: string;
	cards: number;
	sideboard: number;
	colors: string[];
	value: number;
	/** Copies without a price; a deck without any priced card states no value. */
	priced: boolean;
	/** Card names to quote, most notable first (the server passes the most valuable non-commander cards). */
	notable: string[];
};

/**
 * Title and description for the search snippet of a deck page. Like the card pages
 * (cardPageMeta): the facts first, no site suffix, titles within 60 and descriptions within
 * 155 characters. Owner rule for visitor-facing copy: no dashes in our own words; the deck
 * name, author name and card names are quoted as they are.
 */
export function deckPageMeta(deck: DeckMetaInput) {
	const { name, formatLabel: format, commander } = deck;
	// A deck named after its commander needs the name only once.
	const withCommander = commander && !name.toLowerCase().includes(commander.split(' & ')[0].split(',')[0].toLowerCase());
	const titles = [
		...(withCommander ? [`${name}: MTG ${format} deck with ${commander}`, `${name}: ${format} deck with ${commander}`] : []),
		`${name}: MTG ${format} deck`,
		`${name}: ${format} deck`
	];
	const lead = `${format} deck${deck.author ? ` by ${deck.author}` : ''}${commander ? `, led by ${commander}` : ''}`;
	const size = `${deck.cards} card${deck.cards === 1 ? '' : 's'}${deck.sideboard ? ` and ${deck.sideboard} in the sideboard` : ''}`;
	const facts = `${lead}: ${size} in ${colorWords(deck.colors)}${deck.priced ? `, valued at ${formatPrice(deck.value)}` : ''}.`;
	const names = [...new Set(deck.notable)];
	let quote = '';
	for (let n = names.length; n > 0 && !quote; n--) {
		const list = n === 1 ? names[0] : `${names.slice(0, n - 1).join(', ')} and ${names[n - 1]}`;
		const sentence = ` Includes ${list}.`;
		if (facts.length + sentence.length <= DESCRIPTION_MAX) quote = sentence;
	}
	return {
		title: titles.find((title) => title.length <= TITLE_MAX) ?? clip(name, TITLE_MAX),
		description: clip(facts + quote, DESCRIPTION_MAX)
	};
}

/**
 * Canonical and robots rule of the public deck list (/decks): the list and its pages are
 * landing pages, searches, format filters and other sorts are `noindex, follow` (like the
 * card catalogue, catalogSeo()). `view=public` is how signed-in players reach the same list.
 */
export function deckListSeo(search: URLSearchParams, page: number) {
	const filtered = ['q', 'format'].some((key) => (search.get(key) ?? '').trim() !== '') ||
		(search.has('sort') && search.get('sort') !== 'updated');
	const params = new URLSearchParams();
	for (const key of ['q', 'format', 'sort']) {
		const value = (search.get(key) ?? '').trim();
		if (value && !(key === 'sort' && value === 'updated')) params.set(key, value);
	}
	if (page > 1) params.set('page', String(page));
	return { canonical: `${SITE_URL}/decks${params.size ? `?${params}` : ''}`, noindex: filtered };
}
