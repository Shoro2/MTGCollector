/**
 * Deck formats and their construction rules, checked against Scryfall's per-format
 * legality (`cards.legalities`, the same data as the legality grid on card pages).
 * Pure and unit-tested. The check helps while building; it is not a tournament
 * judge: rules Scryfall's data cannot express (Commander-only bans in Duel Commander,
 * companions) are not checked.
 */
import { formatLabel } from './legality';
import { frontType, type Board } from './deck';

export type CommandZone = 'legendary' | 'legendary-or-planeswalker' | 'creature' | 'oathbreaker';
export type DeckFormat = {
	key: string;
	label: string;
	kind: 'constructed' | 'commander' | 'casual';
	/** Cards in the deck: the main deck, for commander formats including the command zone. */
	size?: { min: number; max?: number };
	sideboardMax?: number;
	copies: number;
	command?: CommandZone;
};

const constructed = (key: string): DeckFormat => ({ key, label: formatLabel(key), kind: 'constructed', size: { min: 60 }, sideboardMax: 15, copies: 4 });
const commander = (key: string, size: number, command?: CommandZone): DeckFormat =>
	({ key, label: formatLabel(key), kind: 'commander', size: { min: size, max: size }, copies: 1, command });

/** Offered in the deck dialogs, in this order. Keys are Scryfall's legality keys. */
export const DECK_FORMATS: DeckFormat[] = [
	commander('commander', 100, 'legendary'),
	...['standard', 'pioneer', 'modern', 'legacy', 'vintage', 'pauper'].map(constructed),
	commander('paupercommander', 100, 'creature'),
	commander('duel', 100, 'legendary'),
	commander('predh', 100, 'legendary'),
	commander('oathbreaker', 60, 'oathbreaker'),
	commander('brawl', 100, 'legendary-or-planeswalker'),
	commander('standardbrawl', 60, 'legendary-or-planeswalker'),
	commander('gladiator', 100),
	...['historic', 'timeless', 'explorer', 'alchemy', 'premodern', 'oldschool', 'penny'].map(constructed),
	{ key: 'casual', label: 'Casual', kind: 'casual', copies: Infinity }
];
const BY_KEY = new Map(DECK_FORMATS.map((f) => [f.key, f]));
export const deckFormat = (key: string): DeckFormat => BY_KEY.get(key) ?? BY_KEY.get('casual')!;
export const isDeckFormat = (key: unknown): key is string => typeof key === 'string' && BY_KEY.has(key);

export type RuleCard = {
	board: Board;
	quantity: number;
	name: string;
	type_line: string | null;
	oracle_text: string | null;
	legalities: string | Record<string, string> | null;
	color_identity: string[] | null;
};

const NUMBERS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** Copies a deck may hold: basic lands and "any number of cards named" cards are exempt. */
export function copyLimit(card: Pick<RuleCard, 'type_line' | 'oracle_text'>, base: number): number {
	const type = frontType(card.type_line);
	if (/\bBasic\b/.test(type) && /\bLand\b/.test(type)) return Infinity;
	const text = card.oracle_text ?? '';
	if (/A deck can have any number of cards named/i.test(text)) return Infinity;
	const upTo = /A deck can have up to (\w+) cards named/i.exec(text);
	if (upTo) return NUMBERS[upTo[1].toLowerCase()] ?? (Number(upTo[1]) || base);
	return base;
}

/** May this card lead a deck in the given command zone? */
export function canLead(card: Pick<RuleCard, 'type_line' | 'oracle_text'>, zone: CommandZone): boolean {
	const type = frontType(card.type_line);
	if (/can be your commander/i.test(card.oracle_text ?? '')) return zone !== 'oathbreaker';
	const legendary = /\bLegendary\b/.test(type);
	if (zone === 'creature') return /\bCreature\b/.test(type);
	if (zone === 'oathbreaker') return /\bPlaneswalker\b/.test(type);
	if (zone === 'legendary-or-planeswalker' && legendary && /\bPlaneswalker\b/.test(type)) return true;
	return legendary && /\bCreature\b/.test(type);
}

const firstName = (name: string) => name.split(' // ')[0];

/** Two commanders are allowed when both have Partner (or one Partner with the other), Friends forever, the same Partner variant, or a Background or Doctor pairing. */
export function canPair(a: Pick<RuleCard, 'name' | 'type_line' | 'oracle_text'>, b: Pick<RuleCard, 'name' | 'type_line' | 'oracle_text'>): boolean {
	const text = (c: typeof a) => c.oracle_text ?? '';
	const has = (c: typeof a, pattern: RegExp) => pattern.test(text(c));
	const both = (pattern: RegExp) => has(a, pattern) && has(b, pattern);
	if (both(/^Partner(?: \(|$)/m) || both(/^Friends forever(?: \(|$)/m)) return true;
	const partnerWith = (c: typeof a) => /^Partner with ([^(\n]+?)\s*(?:\(|$)/m.exec(text(c))?.[1];
	if (partnerWith(a) === firstName(b.name) && partnerWith(b) === firstName(a.name)) return true;
	const variant = (c: typeof a) => /^Partner—([^(\n]+?)\s*(?:\(|$)/m.exec(text(c))?.[1];
	if (variant(a) && variant(a) === variant(b)) return true;
	const pairs = (x: typeof a, y: typeof a) =>
		(has(x, /^Choose a Background/m) && /\bBackground\b/.test(frontType(y.type_line))) ||
		(has(x, /^Doctor's companion/m) && /\bTime Lord Doctor\b/.test(frontType(y.type_line)));
	return pairs(a, b) || pairs(b, a);
}

/**
 * Can this commander share the command zone with a second card? True for the abilities
 * canPair() accepts (Partner, Partner with, a Partner variant, Friends forever, Choose a
 * Background, Doctor's companion) and for a Time Lord Doctor, which a companion joins.
 */
export function canHavePartner(card: Pick<RuleCard, 'type_line' | 'oracle_text'>): boolean {
	const text = card.oracle_text ?? '';
	return /^(?:Partner(?: \(|$| with |—)|Friends forever(?: \(|$)|Choose a Background|Doctor's companion)/m.test(text) ||
		/\bTime Lord Doctor\b/.test(frontType(card.type_line));
}

function legalityOf(card: RuleCard, key: string): string | undefined {
	let data = card.legalities;
	if (typeof data === 'string') {
		try {
			data = JSON.parse(data) as Record<string, string>;
		} catch {
			return undefined;
		}
	}
	return data && typeof data === 'object' ? data[key] : undefined;
}

export type DeckProblem = {
	kind: 'size' | 'sideboard' | 'copies' | 'banned' | 'not_legal' | 'restricted' | 'commander' | 'identity';
	message: string;
	cards: string[];
};

const unique = (names: string[]) => [...new Set(names)].sort((a, b) => a.localeCompare(b));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Problems of a deck in its format: deck size, sideboard size, copies, Scryfall
 * legality, the command zone and color identity. Cards without legality data for the
 * format are reported as unchecked, not as problems. The maybeboard is never checked;
 * in commander formats the sideboard is a list of cards under consideration.
 */
export function checkDeck(cards: RuleCard[], key: string): { format: DeckFormat; problems: DeckProblem[]; unchecked: string[] } {
	const format = deckFormat(key);
	const problems: DeckProblem[] = [];
	const unchecked: string[] = [];
	if (format.kind === 'casual') return { format, problems, unchecked };
	const isCommander = format.kind === 'commander';
	const zone = cards.filter((c) => c.board === 'commander');
	const main = cards.filter((c) => c.board === 'main');
	const side = cards.filter((c) => c.board === 'sideboard');
	const deck = [...zone, ...main];
	const counted = isCommander ? deck : [...deck, ...side];
	const total = (list: RuleCard[]) => list.reduce((n, c) => n + c.quantity, 0);
	const add = (kind: DeckProblem['kind'], message: string, names: string[] = []) => problems.push({ kind, message, cards: unique(names) });

	const size = total(deck);
	if (format.size && (size < format.size.min || (format.size.max !== undefined && size > format.size.max))) {
		const need = format.size.max === format.size.min ? `exactly ${format.size.min}` : `at least ${format.size.min}`;
		add('size', `The deck has ${plural(size, 'card')}; ${format.label} needs ${need}${isCommander && format.command ? ', the command zone included' : ''}.`);
	}
	if (format.sideboardMax !== undefined && total(side) > format.sideboardMax) {
		add('sideboard', `The sideboard has ${plural(total(side), 'card')}; ${format.label} allows at most ${format.sideboardMax}.`);
	}

	const copies = new Map<string, { count: number; card: RuleCard }>();
	for (const card of counted) {
		const entry = copies.get(card.name) ?? { count: 0, card };
		entry.count += card.quantity;
		copies.set(card.name, entry);
	}
	const tooMany = [...copies.values()].filter(({ count, card }) => count > copyLimit(card, format.copies)).map((e) => e.card.name);
	if (tooMany.length) add('copies', format.copies === 1 ? 'Only one copy of each card is allowed (basic lands excepted):' : `At most ${format.copies} copies of each card are allowed:`, tooMany);

	const banned: string[] = [], notLegal: string[] = [], restricted: string[] = [], zoneOnly: string[] = [];
	for (const [name, { count, card }] of copies) {
		const status = legalityOf(card, format.key);
		if (status === undefined) unchecked.push(name);
		else if (status === 'banned') banned.push(name);
		else if (status === 'not_legal') notLegal.push(name);
		else if (status === 'restricted') {
			// Pauper Commander marks the uncommon creatures that may only lead the deck.
			if (format.key === 'paupercommander') {
				if (cards.some((c) => c.name === name && c.board !== 'commander' && counted.includes(c))) zoneOnly.push(name);
			} else if (count > 1) restricted.push(name);
		}
	}
	if (banned.length) add('banned', `Banned in ${format.label}:`, banned);
	if (notLegal.length) add('not_legal', `Not legal in ${format.label}:`, notLegal);
	if (restricted.length) add('restricted', `Restricted in ${format.label}, at most one copy:`, restricted);
	if (zoneOnly.length) add('restricted', `Allowed in ${format.label} only as the commander:`, zoneOnly);

	if (!isCommander) {
		if (zone.length) add('commander', `${format.label} has no command zone; move these cards to the main deck:`, zone.map((c) => c.name));
		return { format, problems, unchecked: unique(unchecked) };
	}
	if (!format.command) {
		if (zone.length) add('commander', `${format.label} decks have no commander; move these cards to the main deck:`, zone.map((c) => c.name));
		return { format, problems, unchecked: unique(unchecked) };
	}

	let leaders = zone;
	if (format.command === 'oathbreaker') {
		leaders = zone.filter((c) => canLead(c, 'oathbreaker'));
		const spells = zone.filter((c) => !canLead(c, 'oathbreaker'));
		if (!leaders.length) add('commander', 'Choose an oathbreaker: a planeswalker in the command zone.');
		if (spells.length !== 1 || !/\b(Instant|Sorcery)\b/.test(frontType(spells[0].type_line))) {
			add('commander', 'The command zone holds one oathbreaker and one signature spell (an instant or sorcery).', spells.map((c) => c.name));
		}
		if (leaders.length > 1) add('commander', 'Only one oathbreaker is allowed.', leaders.map((c) => c.name));
	} else {
		const copiesInZone = total(zone);
		if (!zone.length) add('commander', 'Choose a commander.');
		else if (copiesInZone > 2) add('commander', 'At most two commanders are allowed.', zone.map((c) => c.name));
		else if (zone.length === 2 && !canPair(zone[0], zone[1])) {
			add('commander', 'These two cards cannot share the command zone (they need Partner, Friends forever, a Background or a Doctor pairing):', zone.map((c) => c.name));
		} else if (copiesInZone === 2 && zone.length === 1) add('commander', 'The same card cannot be both commanders.', zone.map((c) => c.name));
		const background = zone.length === 2 && canPair(zone[0], zone[1]);
		const notLeaders = zone.filter((c) => !canLead(c, format.command!) && !(background && /\bBackground\b/.test(frontType(c.type_line))));
		if (notLeaders.length) add('commander', 'Cannot be a commander:', notLeaders.map((c) => c.name));
	}

	if (leaders.length) {
		// Both commanders (a Background included) make up the identity; an oathbreaker's
		// signature spell must fit inside it like any other card.
		const identity = new Set(leaders.flatMap((c) => c.color_identity ?? []));
		const outside = deck.filter((c) => !leaders.includes(c) && (c.color_identity ?? []).some((color) => !identity.has(color)));
		if (outside.length) add('identity', "Outside the commander's color identity:", outside.map((c) => c.name));
	}
	return { format, problems, unchecked: unique(unchecked) };
}
