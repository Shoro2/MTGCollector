import { describe, expect, it } from 'vitest';
import { CARD_BACK_HASH, cardBackDistance, isCardBackReference } from './card-back';
import { resolveCard, type FooterReading, type ResolveInput } from './resolve';

// The back hash with 4 bits flipped (the last hex digit c -> 3) and with 12 bits flipped (647c -> 6b83, as far as the nearest front art measured).
const NEAR_BACK = '000b0f9f9d6d6473';
const FAR_FROM_BACK = '000b0f9f9d6d6b83';

const row = (name: string, set: string, num: string, art_hash?: string) => ({ id: `${set}-${num}`, name, set_code: set, collector_number: num, rarity: 'common', ...(art_hash ? { art_hash } : {}) });
const reading = (o: Partial<FooterReading>): FooterReading => ({
	setCode: '', collectorNumber: '', numberSource: 'none', rarity: '', language: 'EN', foilFromText: false,
	variant: 'primary', trustFoil: false, text: '', ...o
});
const sapling = row('Plant a Sapling // Fully-Grown Treefolk', 'mb2', '582');
const bear = row('Large Bear', 'ptk', '7');
const bolt = row('Lightning Bolt', 'm10', '146');
const pool = [sapling, bear, bolt];
const base = (o: Partial<ResolveInput>): ResolveInput => ({
	nameCandidates: [], nameText: '', footer: [], majoritySet: null,
	printingsByName: (n) => pool.filter((r) => r.name === n),
	lookup: (s, n) => pool.filter((r) => r.set_code === s.toLowerCase() && r.collector_number === n.replace(/^0+/, '')),
	isKnownSet: (s) => ['mb2', 'ptk', 'm10'].includes(s.toLowerCase()),
	...o
});

describe('card back', () => {
	it('measures the nearer orientation and recognises the reference itself', () => {
		expect(cardBackDistance(CARD_BACK_HASH)).toBe(0);
		expect(cardBackDistance('ffffffffffffffff', NEAR_BACK)).toBe(4);
		expect(cardBackDistance(FAR_FROM_BACK)).toBe(12);
		expect(cardBackDistance(undefined, 'not a hash')).toBeNull();
		expect(isCardBackReference(CARD_BACK_HASH)).toBe(true);
		expect(isCardBackReference(FAR_FROM_BACK)).toBe(false);
	});

	// The owner's photo of eight card backs (2026-10-29): the backs matched the mb2 back
	// faces at 4-8 bits and partial names read from the pattern ("la Be ha" -> Large Bear 0.50).
	it('offers nothing for a scanned card back, whatever the art channel or a partial name says', () => {
		const d = resolveCard(base({
			artHash: 'ffffffffffffffff', artHashAlt: NEAR_BACK,
			artMatches: [{ row: sapling, distance: 4, rotated: true }],
			nameCandidates: [{ name: 'Large Bear', score: 0.5, pass: 'rotated', text: 'la Be ha' }], nameText: 'la Be ha',
			footer: [reading({ text: 'jj WrT' })]
		}));
		expect(d.cardBack).toBe(true);
		expect(d.identity).toMatchObject({ name: null, state: 'unknown' });
		expect(d.printing.candidates).toEqual([]);
		expect(d.reasons.join(' ')).toContain('card back');
	});

	it('still reads a front: a name that identifies, or a structural collector number', () => {
		const named = resolveCard(base({
			artHash: NEAR_BACK,
			nameCandidates: [{ name: 'Lightning Bolt', score: 0.95, pass: 'primary', text: 'Lightning Bolt' }], nameText: 'Lightning Bolt'
		}));
		expect(named.cardBack).toBeUndefined();
		expect(named.identity).toMatchObject({ name: 'Lightning Bolt', state: 'confirmed' });
		const numbered = resolveCard(base({
			artHash: NEAR_BACK,
			footer: [reading({ setCode: 'M10', collectorNumber: '146', numberSource: 'fraction', text: '146/249 C M10 EN' })]
		}));
		expect(numbered.cardBack).toBeUndefined();
	});

	it('leaves an artwork beyond the card-back distance to the usual rules', () => {
		const d = resolveCard(base({ artHash: FAR_FROM_BACK, artMatches: [{ row: bolt, distance: 4 }] }));
		expect(d.cardBack).toBeUndefined();
		expect(d.identity).toMatchObject({ name: 'Lightning Bolt', state: 'confirmed' });
	});
});
