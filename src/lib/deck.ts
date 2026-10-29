/**
 * Pure deck helpers shared by the deck pages and the server: boards, type groups,
 * the ownership check against a collection, totals and the mana curve. The server
 * module src/lib/server/decks.ts feeds them rows; nothing here touches SQLite.
 */
import { pickMainPrinting, type PrintingSummary } from './card-page';

export const BOARDS = ['commander', 'main', 'sideboard', 'maybeboard'] as const;
export type Board = (typeof BOARDS)[number];
export const BOARD_LABELS: Record<Board, string> = {
	commander: 'Commander',
	main: 'Main deck',
	sideboard: 'Sideboard',
	maybeboard: 'Maybeboard'
};
export const isBoard = (value: unknown): value is Board => BOARDS.includes(value as Board);

export const VISIBILITIES = ['private', 'unlisted', 'public'] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const VISIBILITY_LABELS: Record<Visibility, string> = { private: 'Private', unlisted: 'Unlisted', public: 'Public' };

/**
 * Commander Brackets (Wizards of the Coast, 2025): the power level a deck's owner states,
 * so a table can agree on what to expect. The app stores what the owner chooses; it does
 * not estimate a bracket.
 */
export const BRACKETS = [1, 2, 3, 4, 5] as const;
export type Bracket = (typeof BRACKETS)[number];
export const BRACKET_LABELS: Record<Bracket, string> = { 1: 'Exhibition', 2: 'Core', 3: 'Upgraded', 4: 'Optimized', 5: 'cEDH' };
export const isBracket = (value: unknown): value is Bracket => BRACKETS.includes(value as Bracket);

/** Deck ids are random, so an unlisted deck cannot be found by guessing (72 bits, base64url). */
export const DECK_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
export const isDeckId = (value: string) => DECK_ID_PATTERN.test(value);

/** The type of the face a player sees first: "Sorcery // Land" is a sorcery. */
export function frontType(typeLine: string | null | undefined): string {
	return (typeLine ?? '').split(' // ')[0];
}

export const CATEGORIES = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land', 'Other'] as const;
export type Category = (typeof CATEGORIES)[number];
const CATEGORY_PLURALS: Record<Category, string> = {
	Creature: 'Creatures', Planeswalker: 'Planeswalkers', Battle: 'Battles', Instant: 'Instants', Sorcery: 'Sorceries',
	Artifact: 'Artifacts', Enchantment: 'Enchantments', Land: 'Lands', Other: 'Other'
};
// A card with several types lands in the first that applies: an artifact creature is a
// creature, an artifact land a land, like Moxfield groups them.
const PRECEDENCE: Category[] = ['Creature', 'Planeswalker', 'Battle', 'Land', 'Instant', 'Sorcery', 'Artifact', 'Enchantment'];

export function cardCategory(typeLine: string | null | undefined): Category {
	const type = frontType(typeLine);
	return PRECEDENCE.find((c) => new RegExp(`\\b${c}\\b`).test(type)) ?? 'Other';
}

export type PriceRow = {
	foil: number | boolean;
	price_eur: number | null;
	price_eur_foil: number | null;
	price_usd: number | null;
	price_usd_foil: number | null;
};

/**
 * EUR price of one copy in the deck's finish, USD converted at `usdToEur` when no EUR
 * price exists. A non-foil row of a foil-only printing takes the foil price (that is the
 * only way the printing exists); a foil row never falls back to the non-foil price.
 * Null is a gap, never zero.
 */
export function unitPriceEur(row: PriceRow, usdToEur: number): number | null {
	const eur = (value: number | null, usd: number | null) => value ?? (usd != null ? usd * usdToEur : null);
	if (row.foil) return eur(row.price_eur_foil, row.price_usd_foil);
	return eur(row.price_eur, row.price_usd) ?? eur(row.price_eur_foil, row.price_usd_foil);
}

export type Owned = { real: number; proxy: number };
export type OwnershipState = 'owned' | 'proxy' | 'partial' | 'missing';
/** `printing`: at least one real copy is the deck entry's own printing (not only another one). */
export type Ownership = { real: number; proxy: number; missing: number; state: OwnershipState; printing: boolean };

/** Collection key of a card: any printing of the same card counts (oracle id, else the name). */
export function ownershipKey(card: { oracle_id: string | null; name: string }): string {
	return card.oracle_id ?? `name:${card.name}`;
}

const BOARD_ORDER = new Map(BOARDS.map((b, i) => [b, i]));

/**
 * Hands the viewer's copies to the deck rows in board order (commander, main, sideboard,
 * maybeboard), real copies before proxies, so a card that appears twice is not counted
 * as owned twice. `printings` holds the printing ids the viewer has real copies of.
 */
export function allocateOwnership<T extends { id: number; board: Board; quantity: number; key: string; card_id?: string }>(
	rows: T[],
	owned: Map<string, Owned>,
	printings: Set<string> = new Set()
): Map<number, Ownership> {
	const left = new Map([...owned].map(([key, value]) => [key, { ...value }]));
	const result = new Map<number, Ownership>();
	const ordered = [...rows].sort((a, b) => BOARD_ORDER.get(a.board)! - BOARD_ORDER.get(b.board)! || a.id - b.id);
	for (const row of ordered) {
		const pool = left.get(row.key) ?? { real: 0, proxy: 0 };
		const real = Math.min(row.quantity, pool.real);
		const proxy = Math.min(row.quantity - real, pool.proxy);
		pool.real -= real;
		pool.proxy -= proxy;
		left.set(row.key, pool);
		const missing = row.quantity - real - proxy;
		const state: OwnershipState = real === row.quantity ? 'owned' : missing === 0 ? 'proxy' : real + proxy > 0 ? 'partial' : 'missing';
		result.set(row.id, { real, proxy, missing, state, printing: real > 0 && row.card_id !== undefined && printings.has(row.card_id) });
	}
	return result;
}

export type TotalsRow = PriceRow & { id: number; board: Board; quantity: number };

/**
 * Card counts per board, the deck's value (commander, main deck and sideboard; the
 * maybeboard is only being considered), and with a collection the value still to buy
 * and the value covered by proxies. Unpriced copies are counted, never valued at zero.
 */
export function deckTotals(rows: TotalsRow[], usdToEur: number, ownership?: Map<number, Ownership> | null) {
	const counts: Record<Board, number> = { commander: 0, main: 0, sideboard: 0, maybeboard: 0 };
	let value = 0, unpriced = 0, missingValue = 0, missingCards = 0, missingUnpriced = 0, proxyValue = 0, proxyCards = 0;
	for (const row of rows) {
		counts[row.board] += row.quantity;
		if (row.board === 'maybeboard') continue;
		const price = unitPriceEur(row, usdToEur);
		if (price == null) unpriced += row.quantity;
		else value += price * row.quantity;
		const own = ownership?.get(row.id);
		if (!own) continue;
		missingCards += own.missing;
		proxyCards += own.proxy;
		if (price == null) missingUnpriced += own.missing;
		else {
			missingValue += price * own.missing;
			proxyValue += price * own.proxy;
		}
	}
	const round = (n: number) => Math.round(n * 100) / 100;
	return {
		counts,
		value: round(value),
		unpriced,
		...(ownership
			? { missingValue: round(missingValue), missingCards, missingUnpriced, proxyValue: round(proxyValue), proxyCards }
			: {})
	};
}

/** Copies per mana value 0 to 6 and 7+ over commander and main deck, lands left out. */
export function manaCurve(rows: { board: Board; quantity: number; cmc: number | null; type_line: string | null }[]): number[] {
	const curve = new Array(8).fill(0);
	for (const row of rows) {
		if ((row.board !== 'main' && row.board !== 'commander') || cardCategory(row.type_line) === 'Land') continue;
		curve[Math.min(7, Math.max(0, Math.floor(row.cmc ?? 0)))] += row.quantity;
	}
	return curve;
}

const WUBRG = ['W', 'U', 'B', 'R', 'G'];

/** The deck's colors: its commanders' color identity, or every main-deck card's without one. */
export function deckColors(rows: { board: Board; color_identity: string[] | null }[]): string[] {
	const commanders = rows.filter((r) => r.board === 'commander');
	const source = commanders.length ? commanders : rows.filter((r) => r.board === 'main');
	const colors = new Set(source.flatMap((r) => r.color_identity ?? []));
	return WUBRG.filter((c) => colors.has(c));
}

/**
 * A card the deck editor's search suggests, with its default printing. `partner` is set
 * when the card can share the command zone with a second card (canHavePartner()).
 */
export type CardSuggestion = {
	id: string; name: string; type_line: string | null; mana_cost: string | null; set_code: string; image_uri: string | null; partner: boolean;
};

export type FrameKind = 'w' | 'u' | 'b' | 'r' | 'g' | 'multi' | 'hybrid' | 'artifact' | 'land' | 'colorless';
export type CardFrame = { kind: FrameKind; colors: string[] };

/** Colors in a mana cost, in WUBRG order: {G}, {W/U}, {2/R} and {B/P} all count. */
export function manaColors(cost: string | null | undefined): string[] {
	const found = new Set<string>();
	for (const [, symbol] of (cost ?? '').matchAll(/\{([^}]+)\}/g)) for (const part of symbol.split('/')) if (WUBRG.includes(part)) found.add(part);
	return WUBRG.filter((c) => found.has(c));
}

/**
 * The frame color a printed card of this kind has, for the deck list: one color, gold for
 * several, split for a hybrid card whose colored symbols are all hybrid, silver for a
 * colorless artifact, brown for a colorless land, grey for other colorless cards.
 * `colors` are the card's colors (Scryfall's `colors`); without them (double-faced
 * cards keep them on the faces) the front face's mana cost decides.
 */
export function cardFrame(card: { colors: string[] | null; mana_cost: string | null; type_line: string | null }): CardFrame {
	const colors = WUBRG.filter((c) => (card.colors ?? manaColors(card.mana_cost)).includes(c));
	const type = frontType(card.type_line);
	if (colors.length === 1) return { kind: colors[0].toLowerCase() as FrameKind, colors };
	if (colors.length > 1) {
		const colored = [...(card.mana_cost ?? '').matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).filter((s) => /[WUBRG]/.test(s));
		const hybrid = colors.length === 2 && colored.length > 0 && colored.every((s) => /^[WUBRG]\/[WUBRG]$/.test(s));
		return { kind: hybrid ? 'hybrid' : 'multi', colors };
	}
	if (/\bLand\b/.test(type)) return { kind: 'land', colors };
	if (/\bArtifact\b/.test(type)) return { kind: 'artifact', colors };
	return { kind: 'colorless', colors };
}

export type GroupBy = 'type' | 'cmc' | 'none';
export type SortBy = 'name' | 'cmc' | 'price' | 'owned';

/**
 * Sort order by what the viewer holds: this printing, another printing of the card, some
 * real copies, only proxies, nothing.
 */
export function ownershipRank(own: Ownership | null | undefined): number {
	if (!own) return 5;
	if (own.state === 'owned') return own.printing ? 0 : 1;
	return own.state === 'partial' ? 2 : own.state === 'proxy' ? 3 : 4;
}
export type GroupRow = { id: number; board: Board; quantity: number; name: string; type_line: string | null; cmc: number | null };
export type DeckGroup<T> = { key: string; label: string; count: number; rows: T[] };

/**
 * Columns of the deck view: the command zone first, the main deck by card type (or mana
 * value), then sideboard and maybeboard as one group each. Empty groups are left out.
 */
export function groupDeck<T extends GroupRow>(
	rows: T[], by: GroupBy, sort: SortBy, price: (row: T) => number | null, owned: (row: T) => number = () => 0
): DeckGroup<T>[] {
	const compare = (a: T, b: T) => {
		const byName = a.name.localeCompare(b.name);
		if (sort === 'owned') return owned(a) - owned(b) || byName;
		if (sort === 'cmc') return (a.cmc ?? 0) - (b.cmc ?? 0) || byName;
		if (sort === 'price') return (price(b) ?? -1) - (price(a) ?? -1) || byName;
		return byName;
	};
	const group = (key: string, label: string, list: T[]): DeckGroup<T> => ({
		key, label, rows: [...list].sort(compare), count: list.reduce((n, r) => n + r.quantity, 0)
	});
	const board = (b: Board) => rows.filter((r) => r.board === b);
	const commanders = board('commander');
	const main = board('main');
	const groups: DeckGroup<T>[] = [group('commander', commanders.length > 1 ? 'Commanders' : 'Commander', commanders)];
	if (by === 'type') {
		for (const category of CATEGORIES) {
			groups.push(group(category, CATEGORY_PLURALS[category], main.filter((r) => cardCategory(r.type_line) === category)));
		}
	} else if (by === 'cmc') {
		const spells = main.filter((r) => cardCategory(r.type_line) !== 'Land');
		for (let mv = 0; mv <= 7; mv++) {
			const list = spells.filter((r) => Math.min(7, Math.floor(r.cmc ?? 0)) === mv);
			groups.push(group(`mv${mv}`, `Mana value ${mv === 7 ? '7+' : mv}`, list));
		}
		groups.push(group('Land', 'Lands', main.filter((r) => cardCategory(r.type_line) === 'Land')));
	} else {
		groups.push(group('main', 'Main deck', main));
	}
	groups.push(group('sideboard', 'Sideboard', board('sideboard')), group('maybeboard', 'Maybeboard', board('maybeboard')));
	return groups.filter((g) => g.rows.length > 0);
}

type DeckPrinting = PrintingSummary & { layout?: string | null };
const TOKEN_LAYOUTS = new Set(['token', 'double_faced_token', 'emblem', 'art_series']);

/**
 * Printing a card name resolves to when a list names no set: a real card before a token,
 * a paper printing before a digital-only one, then the card page's representative
 * printing (image and a non-foil price, newest first).
 */
export function pickDeckPrinting<T extends DeckPrinting>(printings: T[]): T | null {
	if (!printings.length) return null;
	const prefer = (list: T[], test: (p: T) => boolean) => (list.some(test) ? list.filter(test) : list);
	const cards = prefer(printings, (p) => !TOKEN_LAYOUTS.has(p.layout ?? ''));
	return pickMainPrinting(prefer(cards, (p) => p.is_paper !== 0));
}

/** "3 hours ago" for the deck list; dates in the future or unparsable ones read "just now". */
export function timeAgo(iso: string, now = Date.now()): string {
	const seconds = Math.max(0, (now - Date.parse(iso)) / 1000) || 0;
	const steps: [number, string][] = [[60, 'second'], [60, 'minute'], [24, 'hour'], [30, 'day'], [12, 'month'], [Infinity, 'year']];
	let value = seconds;
	for (const [size, unit] of steps) {
		if (value < size) {
			const n = Math.floor(value);
			if (unit === 'second') return 'just now';
			return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
		}
		value /= size;
	}
	return 'just now';
}
