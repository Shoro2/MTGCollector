import { describe, it, expect } from 'vitest';
import { resolveCard, numberCompatible, rarityAgrees, type FooterReading, type ResolveInput } from './resolve';

const row = (name: string, set: string, num: string, rarity = 'common') => ({ id: `${set}-${num}`, name, set_code: set, collector_number: num, rarity });
const reading = (o: Partial<FooterReading>): FooterReading => ({
	setCode: '', collectorNumber: '', numberSource: 'none', rarity: '', language: 'EN', foilFromText: false,
	variant: 'primary', trustFoil: false, text: '', ...o
});
const tmt = {
	dawnhart: row('Dawnhart Rejuvenator', 'mid', '180'),
	ronin: row("The Last Ronin's Technique", 'tmt', '323', 'uncommon'),
	raph: row("Raphael's Technique", 'tmt', '237', 'uncommon'),
	cavalry: row('Mechanized Ninja Cavalry', 'tmt', '156'),
	bolt10: row('Lightning Bolt', 'm10', '146'),
	boltLea: row('Lightning Bolt', 'lea', '161'),
	d80: row('Distractor MID #80', 'mid', '80', 'rare'),
	d7: row('Distractor MID #7', 'mid', '7'),
	beggar: row('Beloved Beggar // Generous Soul', 'mid', '3', 'uncommon')
};
const db = Object.values(tmt);
const base = (o: Partial<ResolveInput>): ResolveInput => ({
	nameCandidates: [], nameText: '', footer: [], majoritySet: null,
	printingsByName: (n) => db.filter((r) => r.name === n),
	lookup: (s, n) => db.filter((r) => r.set_code === s.toLowerCase() && r.collector_number === n.replace(/^0+/, '')),
	isKnownSet: (s) => ['mid', 'tmt', 'm10', 'lea', 'vow'].includes(s.toLowerCase()),
	...o
});

describe('numberCompatible / rarityAgrees', () => {
	it('accepts equal, one substituted digit and one dropped digit', () => {
		expect(numberCompatible('0180', '180')).toBe(true);
		expect(numberCompatible('223', '323')).toBe(true);
		expect(numberCompatible('80', '180')).toBe(true);
		expect(numberCompatible('24', '180')).toBe(false);
		expect(numberCompatible('', '180')).toBe(false);
	});
	it('lets a printed L stand for a common basic land', () => {
		expect(rarityAgrees('l', 'common')).toBe(true);
		expect(rarityAgrees('c', 'rare')).toBe(false);
		expect(rarityAgrees('', 'rare')).toBe(true);
	});
});

describe('resolveCard', () => {
	it('confirms a confident name with a unique printing', () => {
		const d = resolveCard(base({ nameCandidates: [{ name: 'Mechanized Ninja Cavalry', score: 1, pass: 'primary' }], nameText: 'Mechanized Ninja Cavalry' }));
		expect(d.identity).toMatchObject({ name: 'Mechanized Ninja Cavalry', state: 'confirmed' });
		expect(d.printing).toMatchObject({ row: tmt.cavalry, state: 'confirmed' });
		expect(d.finish).toBe('unknown');
	});

	it('picks the printing of a confident name from the footer and leaves it open otherwise', () => {
		const withFooter = resolveCard(base({
			nameCandidates: [{ name: 'Lightning Bolt', score: 0.95, pass: 'primary' }], nameText: 'Lightning Bolt',
			footer: [reading({ setCode: 'm10', collectorNumber: '146', numberSource: 'rarity', text: '0146 M10 EN' })]
		}));
		expect(withFooter.printing).toMatchObject({ row: tmt.bolt10, state: 'confirmed' });
		const open = resolveCard(base({ nameCandidates: [{ name: 'Lightning Bolt', score: 0.95, pass: 'primary' }], nameText: 'Lightning Bolt' }));
		expect(open.identity.state).toBe('confirmed');
		expect(open.printing.state).toBe('unknown');
		expect(open.printing.candidates).toHaveLength(2);
	});

	it('identifies a face name against the canonical double-faced record', () => {
		const d = resolveCard(base({ nameCandidates: [{ name: 'Beloved Beggar // Generous Soul', score: 1, pass: 'primary' }], nameText: 'Beloved Beggar' }));
		expect(d.printing.row).toBe(tmt.beggar);
	});

	it('joins a partial name with a dropped-digit number into a likely printing', () => {
		const d = resolveCard(base({
			nameCandidates: [{ name: 'Dawnhart Rejuvenator', score: 0.5, pass: 'primary' }], nameText: 'Dawnhart r',
			footer: [reading({ setCode: 'mid', collectorNumber: '80', numberSource: 'weak', rarity: 'c', text: '80/277 C MID EN' })]
		}));
		expect(d.identity).toMatchObject({ name: 'Dawnhart Rejuvenator', state: 'likely' });
		expect(d.printing).toMatchObject({ row: tmt.dawnhart, state: 'likely' });
	});

	it('joins a partial name with a one-edit number in the majority set', () => {
		const d = resolveCard(base({
			nameCandidates: [{ name: "The Last Ronin's Technique", score: 0.58, pass: 'raw-line' }], nameText: 'FE LAST Wome Techmaue',
			footer: [reading({ setCode: 'tht', collectorNumber: '223', numberSource: 'weak', text: 'v 223 THT EN' })],
			majoritySet: 'tmt'
		}));
		expect(d.printing).toMatchObject({ row: tmt.ronin, state: 'likely' });
	});

	it('confirms a strong footer reading with an unreadable name', () => {
		const d = resolveCard(base({
			nameText: 'A a bl ali',
			footer: [reading({ setCode: 'tmt', collectorNumber: '156', numberSource: 'rarity', rarity: 'c', text: 'C 0156 TMT EN' })]
		}));
		expect(d.identity).toMatchObject({ name: 'Mechanized Ninja Cavalry', state: 'confirmed' });
	});

	it('rejects a strong reading whose rarity letter contradicts the hit', () => {
		const d = resolveCard(base({
			footer: [reading({ setCode: 'mid', collectorNumber: '80', numberSource: 'fraction', rarity: 'c', text: '080/277 C MID EN' })]
		}));
		expect(d.identity.state).toBe('unknown');
		expect(d.printing.candidates).toHaveLength(0);
	});

	it('neither identifies nor suggests from a weak number without any name agreement', () => {
		const d = resolveCard(base({
			nameText: 'TT TE a. -',
			footer: [reading({ setCode: 'mid', collectorNumber: '7', numberSource: 'weak', rarity: 'c', text: 'WosZ7 C MID EN' })]
		}));
		expect(d.identity.state).toBe('unknown');
		expect(d.printing.candidates).toEqual([]);
		expect(d.reasons.join(' ')).toContain('no suggestion');
	});

	it('suggests a structural number-only hit even without name agreement', () => {
		const d = resolveCard(base({
			nameText: 'd',
			footer: [reading({ collectorNumber: '85', numberSource: 'padded', text: '0085 1T EN' }), reading({ collectorNumber: '85', numberSource: 'padded', text: '0085 IT EN', variant: 'rotated small' })],
			majoritySet: 'tmt',
			lookup: (s, n) => (s === 'tmt' && n === '85' ? [row('Bot Bashing Time', 'tmt', '85')] : [])
		}));
		expect(d.identity.state).toBe('unknown');
		expect(d.printing.candidates.map((r) => r.name)).toEqual(['Bot Bashing Time']);
	});

	it('lets a name candidate veto a number-only hit of a different card', () => {
		const d = resolveCard(base({
			nameCandidates: [{ name: 'Dawnhart Rejuvenator', score: 0.5, pass: 'primary' }], nameText: 'Dawnhart r',
			footer: [reading({ setCode: 'mid', collectorNumber: '80', numberSource: 'fraction', text: '080/277 MID EN' })],
			printingsByName: () => [] // the join has nothing to work with
		}));
		expect(d.identity.state).toBe('unknown');
		expect(d.reasons.join(' ')).toContain('points at "Dawnhart Rejuvenator"');
	});

	it('raises a conflict when two footer variants agree on another card than the name', () => {
		const d = resolveCard(base({
			nameCandidates: [{ name: 'Lightning Bolt', score: 0.9, pass: 'primary' }], nameText: 'Lightning Bolt',
			footer: [
				reading({ setCode: 'tmt', collectorNumber: '156', numberSource: 'rarity', text: 'C 0156 TMT EN', variant: 'primary' }),
				reading({ setCode: 'tmt', collectorNumber: '156', numberSource: 'rarity', text: 'C 0156 TMT EN', variant: 'small' })
			]
		}));
		expect(d.identity.state).toBe('conflict');
		expect(d.printing.candidates.map((r) => r.name)).toContain('Mechanized Ninja Cavalry');
	});

	it('takes finish and language from a trusted reading only', () => {
		const tess = resolveCard(base({ footer: [reading({ setCode: 'tmt', collectorNumber: '156', numberSource: 'rarity', foilFromText: true, text: 'C 0156 TMT * EN' })] }));
		expect(tess.finish).toBe('unknown');
		expect(tess.language).toBe('EN');
		const trusted = resolveCard(base({ footer: [reading({ setCode: 'tmt', collectorNumber: '156', numberSource: 'rarity', foilFromText: true, trustFoil: true, variant: 'trusted engine', text: 'C 0156 TMT ★ EN' })] }));
		expect(trusted.finish).toBe('foil');
	});
});

describe('resolveCard — exact agreement confirms', () => {
	it('confirms a partial name whose printed number and set are read exactly', () => {
		const negate = [{ id: 'tmt-47', name: 'Negate', set_code: 'tmt', collector_number: '47', rarity: 'common' }, { id: 'm20-69', name: 'Negate', set_code: 'm20', collector_number: '69', rarity: 'common' }];
		const d = resolveCard({
			nameCandidates: [{ name: 'Negate', score: 0.55, pass: 'primary' }], nameText: 'I Negate Ea',
			footer: [reading({ setCode: 'tmt', collectorNumber: '47', numberSource: 'rarity', rarity: 'c', text: 'ARERR C 0047 TMT EN' })],
			majoritySet: null, printingsByName: () => negate, lookup: () => [], isKnownSet: (s) => s === 'tmt'
		});
		expect(d.identity).toMatchObject({ name: 'Negate', state: 'confirmed' });
		expect(d.printing).toMatchObject({ row: negate[0], state: 'confirmed' });
	});
});

describe('resolveCard — near-number suggestion', () => {
	it('suggests the single rarity-consistent printing one digit away when nothing else resolves', () => {
		const ronin = row("The Last Ronin's Technique", 'tmt', '323', 'uncommon');
		const d = resolveCard(base({
			nameText: '- on Bt',
			footer: [reading({ setCode: 'tht', collectorNumber: '223', numberSource: 'rarity', rarity: 'u', text: 'U 0223 THT EN' })],
			majoritySet: 'tmt',
			lookup: () => [],
			nearLookup: (s, n, rar) => (s === 'tmt' && n === '223' && rar === 'u' ? [ronin] : [])
		}));
		expect(d.identity.state).toBe('unknown');
		expect(d.printing.candidates).toEqual([ronin]);
	});
});

describe('resolveCard — partial name suggestion', () => {
	it('offers the printings of an uncorroborated partial name as suggestions', () => {
		const immolation = row('Immolation', 'mid', '144');
		const d = resolveCard(base({
			nameCandidates: [{ name: 'Immolation', score: 0.5, pass: 'binarized' }], nameText: 'wmotorion',
			footer: [reading({ text: 'S85 F777 junk' })],
			printingsByName: (n) => (n === 'Immolation' ? [immolation] : [])
		}));
		expect(d.identity.state).toBe('unknown');
		expect(d.printing.candidates).toEqual([immolation]);
	});
});
