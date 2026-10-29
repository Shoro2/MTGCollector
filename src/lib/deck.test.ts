import { describe, expect, it } from 'vitest';
import {
	allocateOwnership, ownershipRank, cardCategory, cardFrame, deckColors, deckTotals, groupDeck, isBracket, manaColors, manaCurve, pickDeckPrinting,
	timeAgo, unitPriceEur, type Board
} from './deck';

const price = { price_eur: null, price_eur_foil: null, price_usd: null, price_usd_foil: null };

describe('cardCategory', () => {
	it('groups by the front face with creature, land and spell precedence', () => {
		expect(cardCategory('Artifact Creature — Golem')).toBe('Creature');
		expect(cardCategory('Artifact Land')).toBe('Land');
		expect(cardCategory('Legendary Enchantment Creature — God')).toBe('Creature');
		expect(cardCategory('Kindred Instant — Elf')).toBe('Instant');
		expect(cardCategory('Sorcery // Land')).toBe('Sorcery');
		expect(cardCategory('Land // Land')).toBe('Land');
		expect(cardCategory('Legendary Planeswalker — Jace')).toBe('Planeswalker');
		expect(cardCategory('Battle — Siege')).toBe('Battle');
		expect(cardCategory('Conspiracy')).toBe('Other');
		expect(cardCategory(null)).toBe('Other');
	});
});

describe('unitPriceEur', () => {
	it('prefers EUR, converts USD and never invents a price', () => {
		expect(unitPriceEur({ ...price, foil: 0, price_eur: 2, price_usd: 10 }, 0.9)).toBe(2);
		expect(unitPriceEur({ ...price, foil: 0, price_usd: 10 }, 0.9)).toBe(9);
		expect(unitPriceEur({ ...price, foil: 1, price_eur: 2 }, 0.9)).toBeNull();
		expect(unitPriceEur({ ...price, foil: 1, price_eur_foil: 5, price_eur: 2 }, 0.9)).toBe(5);
		// A foil-only printing has only a foil price; that is its price in a non-foil row too.
		expect(unitPriceEur({ ...price, foil: 0, price_usd_foil: 20 }, 0.5)).toBe(10);
		expect(unitPriceEur({ ...price, foil: 0 }, 0.9)).toBeNull();
	});
});

describe('allocateOwnership', () => {
	const row = (id: number, board: Board, quantity: number, key = 'bolt') => ({ id, board, quantity, key });
	it('spends real copies before proxies and never counts a copy twice', () => {
		const owned = new Map([['bolt', { real: 3, proxy: 2 }]]);
		const result = allocateOwnership([row(2, 'sideboard', 2), row(1, 'main', 4)], owned);
		expect(result.get(1)).toEqual({ real: 3, proxy: 1, missing: 0, state: 'proxy', printing: false });
		expect(result.get(2)).toEqual({ real: 0, proxy: 1, missing: 1, state: 'partial', printing: false });
		expect(owned.get('bolt')).toEqual({ real: 3, proxy: 2 });
	});
	it('marks owned, missing and commander-first allocation', () => {
		const owned = new Map([['cmd', { real: 1, proxy: 0 }]]);
		const result = allocateOwnership([row(5, 'main', 1, 'cmd'), row(9, 'commander', 1, 'cmd'), row(6, 'main', 1, 'other')], owned);
		expect(result.get(9)?.state).toBe('owned');
		expect(result.get(5)?.state).toBe('missing');
		expect(result.get(6)).toEqual({ real: 0, proxy: 0, missing: 1, state: 'missing', printing: false });
	});
	it("tells the deck's own printing from another printing of the card", () => {
		const owned = new Map([['bolt', { real: 2, proxy: 1 }]]);
		const rows = [{ ...row(1, 'main', 1), card_id: 'clu' }, { ...row(2, 'main', 1), card_id: 'lea' }, { ...row(3, 'sideboard', 2), card_id: 'clu' }];
		const result = allocateOwnership(rows, owned, new Set(['clu']));
		expect([1, 2, 3].map((id) => [result.get(id)?.state, result.get(id)?.printing])).toEqual([['owned', true], ['owned', false], ['partial', false]]);
		expect([1, 2, 3].map((id) => ownershipRank(result.get(id)))).toEqual([0, 1, 2]);
		expect(ownershipRank({ real: 0, proxy: 1, missing: 0, state: 'proxy', printing: false })).toBe(3);
		expect(ownershipRank({ real: 1, proxy: 0, missing: 1, state: 'partial', printing: true })).toBe(2);
		expect(ownershipRank({ real: 0, proxy: 0, missing: 1, state: 'missing', printing: false })).toBe(4);
		expect(ownershipRank(null)).toBe(5);
	});
});

describe('deckTotals', () => {
	const rows = [
		{ id: 1, board: 'commander' as Board, quantity: 1, foil: 0, ...price, price_eur: 10 },
		{ id: 2, board: 'main' as Board, quantity: 4, foil: 0, ...price, price_eur: 1.25 },
		{ id: 3, board: 'main' as Board, quantity: 2, foil: 0, ...price },
		{ id: 4, board: 'sideboard' as Board, quantity: 1, foil: 1, ...price, price_usd_foil: 4 },
		{ id: 5, board: 'maybeboard' as Board, quantity: 3, foil: 0, ...price, price_eur: 100 }
	];
	it('values commander, main and sideboard, keeps gaps and leaves the maybeboard out', () => {
		const totals = deckTotals(rows, 0.5);
		expect(totals.counts).toEqual({ commander: 1, main: 6, sideboard: 1, maybeboard: 3 });
		expect(totals.value).toBe(17);
		expect(totals.unpriced).toBe(2);
		expect(totals).not.toHaveProperty('missingValue');
	});
	it('prices what is still missing and what proxies stand in for', () => {
		const ownership = allocateOwnership(rows.map((r) => ({ ...r, key: String(r.id) })), new Map([['1', { real: 1, proxy: 0 }], ['2', { real: 1, proxy: 2 }]]));
		const totals = deckTotals(rows, 0.5, ownership);
		expect(totals).toMatchObject({ missingValue: 3.25, missingCards: 4, missingUnpriced: 2, proxyValue: 2.5, proxyCards: 2 });
	});
});

describe('manaCurve and deckColors', () => {
	it('counts spells of commander and main deck by mana value, 7 and more together', () => {
		const curve = manaCurve([
			{ board: 'commander', quantity: 1, cmc: 4, type_line: 'Legendary Creature' },
			{ board: 'main', quantity: 2, cmc: 1, type_line: 'Instant' },
			{ board: 'main', quantity: 1, cmc: 9, type_line: 'Sorcery' },
			{ board: 'main', quantity: 30, cmc: 0, type_line: 'Basic Land — Forest' },
			{ board: 'sideboard', quantity: 3, cmc: 2, type_line: 'Instant' }
		]);
		expect(curve).toEqual([0, 2, 0, 0, 1, 0, 0, 1]);
	});
	it("uses the commanders' identity, else the main deck's, in WUBRG order", () => {
		expect(deckColors([{ board: 'commander', color_identity: ['G', 'U'] }, { board: 'main', color_identity: ['R'] }])).toEqual(['U', 'G']);
		expect(deckColors([{ board: 'main', color_identity: ['R', 'W'] }, { board: 'sideboard', color_identity: ['B'] }])).toEqual(['W', 'R']);
	});
});

describe('groupDeck', () => {
	const card = (id: number, board: Board, name: string, type_line: string, cmc = 0, quantity = 1) => ({ id, board, name, type_line, cmc, quantity });
	const rows = [
		card(1, 'main', 'Zealous Conscripts', 'Creature — Human', 5),
		card(2, 'main', 'Abrade', 'Instant', 2),
		card(3, 'main', 'Mountain', 'Basic Land — Mountain', 0, 30),
		card(4, 'commander', 'Krenko, Mob Boss', 'Legendary Creature — Goblin', 4),
		card(5, 'main', 'Beast Within', 'Instant', 3),
		card(6, 'sideboard', 'Pyroblast', 'Instant', 1),
		card(7, 'maybeboard', 'Shock', 'Instant', 1)
	];
	it('puts the command zone first, then card types, sideboard and maybeboard', () => {
		const groups = groupDeck(rows, 'type', 'name', () => null);
		expect(groups.map((g) => [g.label, g.count])).toEqual([
			['Commander', 1], ['Creatures', 1], ['Instants', 2], ['Lands', 30], ['Sideboard', 1], ['Maybeboard', 1]
		]);
		expect(groups[2].rows.map((r) => r.name)).toEqual(['Abrade', 'Beast Within']);
	});
	it('groups by mana value with lands last and sorts by price', () => {
		const prices: Record<number, number | null> = { 2: 1, 5: 3 };
		const groups = groupDeck(rows, 'cmc', 'price', (r) => prices[r.id] ?? null);
		expect(groups.map((g) => g.label)).toEqual(['Commander', 'Mana value 2', 'Mana value 3', 'Mana value 5', 'Lands', 'Sideboard', 'Maybeboard']);
		expect(groupDeck(rows, 'none', 'cmc', () => null)[1].rows.map((r) => r.name)).toEqual(['Mountain', 'Abrade', 'Beast Within', 'Zealous Conscripts']);
	});
	it('sorts by what the viewer owns, then by name', () => {
		const ranks: Record<number, number> = { 1: 0, 2: 4, 3: 1, 5: 1 };
		expect(groupDeck(rows, 'none', 'owned', () => null, (r) => ranks[r.id] ?? 4)[1].rows.map((r) => r.name))
			.toEqual(['Zealous Conscripts', 'Beast Within', 'Mountain', 'Abrade']);
	});
});

describe('pickDeckPrinting', () => {
	const p = (id: string, extra: Record<string, unknown>) => ({
		id, set_code: id, set_name: id, collector_number: '1', rarity: 'common', released_at: '2020-01-01', image_uri: 'x', local_image_path: null,
		...price, price_eur: 1, is_paper: 1, layout: 'normal', ...extra
	});
	it('prefers real paper cards, then the representative printing', () => {
		expect(pickDeckPrinting([p('tok', { layout: 'token', released_at: '2025-01-01' }), p('card', {})])?.id).toBe('card');
		expect(pickDeckPrinting([p('arena', { is_paper: 0, released_at: '2025-01-01' }), p('paper', {})])?.id).toBe('paper');
		expect(pickDeckPrinting([p('old', {}), p('new', { released_at: '2024-01-01' })])?.id).toBe('new');
		expect(pickDeckPrinting([])).toBeNull();
	});
});

describe('timeAgo', () => {
	it('reads like a deck list', () => {
		const now = Date.parse('2026-10-22T12:00:00Z');
		expect(timeAgo('2026-10-22T11:59:30Z', now)).toBe('just now');
		expect(timeAgo('2026-10-22T11:00:00Z', now)).toBe('1 hour ago');
		expect(timeAgo('2026-10-19T12:00:00Z', now)).toBe('3 days ago');
		expect(timeAgo('2026-03-01T12:00:00Z', now)).toBe('7 months ago');
		expect(timeAgo('2023-10-01T12:00:00Z', now)).toBe('3 years ago');
		expect(timeAgo('garbage', now)).toBe('just now');
	});
});

describe('card frames', () => {
	const frame = (colors: string[] | null, mana_cost: string | null, type_line = 'Instant') => cardFrame({ colors, mana_cost, type_line });
	it('reads the colors of a mana cost', () => {
		expect(manaColors('{2}{G}{W/U}{B/P}{2/R}{C}{X}')).toEqual(['W', 'U', 'B', 'R', 'G']);
		expect(manaColors(null)).toEqual([]);
	});
	it('gives one color its own frame and several a gold one', () => {
		expect(frame(['R'], '{R}')).toEqual({ kind: 'r', colors: ['R'] });
		expect(frame(['G', 'U'], '{1}{G}{U}').kind).toBe('multi');
		expect(frame(['U', 'G'], '{1}{G}{U}').colors).toEqual(['U', 'G']);
		expect(frame(['W', 'U', 'B', 'R', 'G'], '{W}{U}{B}{R}{G}').kind).toBe('multi');
	});
	it('splits a two-color hybrid card, not a gold card with a hybrid symbol', () => {
		expect(frame(['G', 'W'], '{1}{G/W}{G/W}')).toEqual({ kind: 'hybrid', colors: ['W', 'G'] });
		expect(frame(['R', 'G'], '{R}{R/G}').kind).toBe('multi');
		expect(frame(['W', 'U', 'B'], '{W/U}{B/W}').kind).toBe('multi');
	});
	it('frames colorless cards as artifact, land or colorless', () => {
		expect(frame([], '{1}', 'Artifact').kind).toBe('artifact');
		expect(frame([], '{0}', 'Artifact Creature — Golem').kind).toBe('artifact');
		expect(frame([], null, 'Basic Land — Forest').kind).toBe('land');
		expect(frame(['G'], null, 'Land Creature — Forest Dryad').kind).toBe('g');
		expect(frame([], '{10}', 'Creature — Eldrazi').kind).toBe('colorless');
		expect(frame([], '{3}{U}', 'Creature — Eldrazi Drone').kind).toBe('colorless');
	});
	it('falls back to the mana cost when the card stores no colors', () => {
		expect(frame(null, '{U}', 'Creature — Human Wizard // Creature — Human Insect').kind).toBe('u');
		expect(frame(null, null, 'Land // Land').kind).toBe('land');
	});
});

describe('brackets', () => {
	it('accepts the five Commander Brackets only', () => {
		expect([1, 2, 3, 4, 5].every(isBracket)).toBe(true);
		expect([0, 6, '3', 2.5, null].some(isBracket)).toBe(false);
	});
});
