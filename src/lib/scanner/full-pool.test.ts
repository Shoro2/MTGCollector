/**
 * Regressions measured against the full card pool (Round 10, September
 * 2026): the eight development photos were first scored against a seeded
 * database with ~70 names, where the matching rules had nothing to collide
 * with. Against ~38k distinct names (plus tokens and art-series records) the
 * same rules produced 23 wrong identities. These tests pin the contract that
 * removed them: a name alone identifies a card only with enough substance,
 * the footer wins over an uncertain name it contradicts, close runner-ups are
 * offered instead of guessed, and candidate lists are ranked by similarity.
 */
import { describe, expect, it } from 'vitest';
import { bestAlias, bestNameMatch, rankNameMatches } from './similarity';
import { artPool, nameIdentifies, resolveCard, type FooterReading, type ResolveInput } from './resolve';

const row = (name: string, set: string, num: string, rarity = 'common', art_hash?: string) => ({ id: `${set}-${num}`, name, set_code: set, collector_number: num, rarity, ...(art_hash ? { art_hash } : {}) });
const reading = (o: Partial<FooterReading>): FooterReading => ({
	setCode: '', collectorNumber: '', numberSource: 'none', rarity: '', language: 'EN', foilFromText: false,
	variant: 'primary', trustFoil: false, text: '', ...o
});
const pool = [
	row('Mechanized Ninja Cavalry', 'tmt', '156'),
	row('Llanowar Cavalry', 'inv', '195'),
	row("Shredder's Revenge", 'tmt', '76', 'rare'),
	row('Shredder, Unrelenting', 'tmt', '74', 'uncommon'),
	row('Dawnhart Rejuvenator', 'mid', '180', 'common', '0000000000000000'),
	row('Dawnhart Rejuvenator', 'dbl', '180', 'common', '00000000000000ff'), // the Double Feature reprint: same artwork, 8 bits off
	row('Dawnhart Geist', 'vow', '8', 'uncommon'),
	row('Dawnhart Geist', 'dbl', '275', 'uncommon'),
	row('Rainveil Rejuvenator', 'tdm', '152'),
	row('Kronch Wrangler', 'clu', '169'),
	row('Skaab Wrangler', 'mid', '75', 'uncommon'),
	row('Lightning Bolt', 'm10', '146'),
	row('Lightning Bolt', 'lea', '161'),
	row('Great Sable Stag', 'm10', '147', 'rare'),
	row('Lightning Helix', 'rvr', '372', 'uncommon')
];
const base = (o: Partial<ResolveInput>): ResolveInput => ({
	nameCandidates: [], nameText: '', footer: [], majoritySet: null,
	printingsByName: (n) => pool.filter((r) => r.name === n),
	lookup: (s, n) => pool.filter((r) => r.set_code === s.toLowerCase() && r.collector_number === n.replace(/^0+/, '')),
	isKnownSet: (s) => ['mid', 'tmt', 'm10', 'lea', 'vow', 'inv', 'dbl', 'tdm', 'clu', 'rvr'].includes(s.toLowerCase()),
	...o
});

describe('nameIdentifies — how much name evidence identifies a card on its own', () => {
	it.each([
		['Boa', 'Boar', 0.75],
		['Cal', 'Beck // Call', 0.75],
		['ma', 'Map', 0.67],
		['fasten', 'Fast // Furious', 0.67]
	])('needs an exact read for a short name or face: "%s" -> %s', (text, name, score) => {
		expect(nameIdentifies({ name, score }, text)).toBe(false);
	});

	it.each([
		['Easy Te', 'Easy Prey', 0.667],
		['wor go SEED, BIT Fn INI INOF', 'Horizon Seed', 0.647],
		['Rane Town a', 'Value Town // Take a Trip to...', 0.68],
		// A capitalised fragment is mana-symbol junk, not a word, unless the match is near-certain.
		['HEASTCE', 'Headstone', 0.67]
	])('needs a real word in the OCR text unless the match is near-certain: "%s" -> %s', (text, name, score) => {
		expect(nameIdentifies({ name, score }, text)).toBe(false);
	});

	it.each([
		['Negae', 'Negate', 0.83],
		['Nobod', 'Nobody', 0.83],
		['Opt', 'Opt', 1],
		['utant Town', 'Mutant Town', 0.9],
		["Olivia's Midnis ght Ambush", "Olivia's Midnight Ambush", 0.92],
		['Mechanized Ninja Cavalry', 'Mechanized Ninja Cavalry', 1],
		['Beloved Beggar', 'Beloved Beggar // Generous Soul', 1],
		// Showcase frames print the name in capitals: no lower-case "real word", but the match is near-certain.
		["fi LAST ROMIN'S TECHNIQUE", "The Last Ronin's Technique", 0.846]
	])('accepts substantial evidence: "%s" -> %s', (text, name, score) => {
		expect(nameIdentifies({ name, score }, text)).toBe(true);
	});

	it('rejects anything below the confirmation threshold', () => {
		expect(nameIdentifies({ name: 'Mechanized Ninja Cavalry', score: 0.59 }, 'Mechanized Ninja Cavalry')).toBe(false);
	});
});

describe('resolveCard — an uncertain name against the footer', () => {
	it('lets a strong footer reading beat an uncertain name when its card also fits the name text', () => {
		const d = resolveCard(base({
			nameCandidates: [{ name: 'Llanowar Cavalry', score: 0.63, pass: 'rotated binarized' }], nameText: 'pean Zia Cavalry',
			footer: [reading({ setCode: 'tmt', collectorNumber: '156', numberSource: 'rarity', rarity: 'c', text: 'C 0156 TMT EN' })]
		}));
		expect(d.identity).toMatchObject({ name: 'Mechanized Ninja Cavalry', state: 'confirmed' });
		expect(d.printing).toMatchObject({ row: pool[0], state: 'confirmed' });
	});

	it('lets an exact fraction reading beat an uncertain name of another set', () => {
		const d = resolveCard(base({
			nameCandidates: [{ name: 'Rainveil Rejuvenator', score: 0.7, pass: 'primary' }], nameText: 'i re- Rejuvenator',
			footer: [reading({ setCode: 'mid', collectorNumber: '180', numberSource: 'fraction', rarity: 'c', text: '180/277 C MID EN' })]
		}));
		expect(d.identity).toMatchObject({ name: 'Dawnhart Rejuvenator', state: 'confirmed' });
		expect(d.printing.row).toMatchObject({ set_code: 'mid', collector_number: '180' });
	});

	it('offers the majority-set card as likely when the set code itself was unreadable', () => {
		const d = resolveCard(base({
			nameCandidates: [{ name: "Shredder's Revenge", score: 0.63, pass: 'rotated' }], nameText: 'Shredder, DiifEleing',
			footer: [reading({ setCode: 'tht', collectorNumber: '74', numberSource: 'rarity', rarity: 'u', text: 'VU 0074 THT EN' })],
			majoritySet: 'tmt'
		}));
		expect(d.identity).toMatchObject({ name: 'Shredder, Unrelenting', state: 'likely' });
		expect(d.printing.row).toMatchObject({ set_code: 'tmt', collector_number: '74' });
	});

	it('keeps an uncertain name whose printing is one digit away from the footer (misread digit)', () => {
		const d = resolveCard(base({
			nameCandidates: [{ name: 'Lightning Bolt', score: 0.7, pass: 'primary' }], nameText: 'Lightnng Bolt',
			footer: [reading({ setCode: 'm10', collectorNumber: '147', numberSource: 'rarity', rarity: 'c', text: 'C 0147 M10 EN' })]
		}));
		expect(d.identity).toMatchObject({ name: 'Lightning Bolt', state: 'confirmed' });
		expect(d.printing).toMatchObject({ row: pool[11], state: 'confirmed' });
	});

	it('demotes an uncertain name to likely when a read set code has no printing of it', () => {
		const d = resolveCard(base({
			nameCandidates: [{ name: 'Dawnhart Geist', score: 0.75, pass: 'rotated paddle' }], nameText: 'Dawnhart Reinont',
			footer: [reading({ setCode: 'mid', collectorNumber: '7', numberSource: 'weak', rarity: 'c', text: 'WosZ7 C MID EN' })]
		}));
		expect(d.identity).toMatchObject({ name: 'Dawnhart Geist', state: 'likely' });
		expect(d.printing.candidates.map((r) => r.name)).toEqual(['Dawnhart Geist', 'Dawnhart Geist']);
	});

	it('prefers a lesser candidate that joins with the footer over an uncertain name the footer contradicts', () => {
		const d = resolveCard(base({
			nameCandidates: [{ name: 'Dawnhart Geist', score: 0.643, pass: 'primary' }, { name: 'Dawnhart Rejuvenator', score: 0.5, pass: 'primary' }], nameText: 'Dawnhart r',
			footer: [reading({ setCode: 'mid', collectorNumber: '80', numberSource: 'weak', rarity: 'c', text: '80/277 C MID EN' })]
		}));
		expect(d.identity).toMatchObject({ name: 'Dawnhart Rejuvenator', state: 'likely' });
		expect(d.printing.row).toMatchObject({ set_code: 'mid', collector_number: '180' });
	});

	it('leaves a certain name alone even when a single strong reading names another card', () => {
		const d = resolveCard(base({
			nameCandidates: [{ name: 'Lightning Bolt', score: 0.95, pass: 'primary' }], nameText: 'Lightning Bolt',
			footer: [reading({ setCode: 'tmt', collectorNumber: '156', numberSource: 'rarity', rarity: 'c', text: 'C 0156 TMT EN' })]
		}));
		expect(d.identity).toMatchObject({ name: 'Lightning Bolt', state: 'confirmed' });
	});
});

describe('resolveCard — close runner-up candidates', () => {
	it('offers both names for one tap instead of confirming the marginally better one', () => {
		const d = resolveCard(base({
			nameCandidates: [{ name: 'Kronch Wrangler', score: 0.6, pass: 'binarized' }, { name: 'Skaab Wrangler', score: 0.57, pass: 'binarized' }], nameText: 'Moist wranger'
		}));
		expect(d.identity).toMatchObject({ name: 'Kronch Wrangler', state: 'likely' });
		expect(d.printing.candidates.map((r) => r.name)).toEqual(['Kronch Wrangler', 'Skaab Wrangler']);
	});

	it('measures the runner-up on the whole text, not on a junk-tolerant prefix', () => {
		// "W Courier of Cotesiiis": the prefix "W Courier" scores 0.65 against Aven
		// Courier once "of Cotesiiis" is written off as junk, but that word is the
		// evidence for Courier of Comestibles (0.68 on the whole text).
		const courier = [row('Courier of Comestibles', 'tmt', '112'), row('Aven Courier', 'xln', '5', 'uncommon')];
		const d = resolveCard(base({
			nameCandidates: [{ name: 'Courier of Comestibles', score: 0.682, pass: 'rotated' }, { name: 'Aven Courier', score: 0.647, pass: 'rotated' }], nameText: 'W Courier of Cotesiiis',
			printingsByName: (n) => courier.filter((r) => r.name === n)
		}));
		expect(d.identity).toMatchObject({ name: 'Courier of Comestibles', state: 'confirmed' });
	});

	it('measures the best candidate on the whole text too, so a prefix-only match cannot outrun a fuller one', () => {
		// "Ghoulish ro": Ghoulflesh scores 0.68 through the prefix "Ghoulish" alone (0.46 on the
		// whole text) while Ghoulish Procession reads 0.58 on the whole text — one tap, not a guess.
		const ghouls = [row('Ghoulflesh', 'avr', '103'), row('Ghoulish Procession', 'mid', '102')];
		const d = resolveCard(base({
			nameCandidates: [{ name: 'Ghoulflesh', score: 0.679, pass: 'primary' }, { name: 'Ghoulish Procession', score: 0.579, pass: 'primary' }], nameText: 'Ghoulish ro',
			printingsByName: (n) => ghouls.filter((r) => r.name === n)
		}));
		expect(d.identity).toMatchObject({ name: 'Ghoulflesh', state: 'likely' });
		expect(d.printing.candidates.map((r) => r.name)).toEqual(['Ghoulflesh', 'Ghoulish Procession']);
	});

	it('confirms a certain name regardless of runner-ups', () => {
		const d = resolveCard(base({
			nameCandidates: [{ name: 'Lightning Bolt', score: 0.95, pass: 'primary' }, { name: 'Lightning Helix', score: 0.9, pass: 'primary' }], nameText: 'Lightning Bolt'
		}));
		expect(d.identity).toMatchObject({ name: 'Lightning Bolt', state: 'confirmed' });
	});

	it('does not confirm a short-name match on its own but still offers it', () => {
		const boar = row('Boar', 'tsoc', '15');
		const d = resolveCard(base({
			nameCandidates: [{ name: 'Boar', score: 0.75, pass: 'raw-line gray' }], nameText: 'Boa',
			printingsByName: (n) => (n === 'Boar' ? [boar] : [])
		}));
		expect(d.identity.state).toBe('unknown');
		expect(d.printing.candidates).toEqual([boar]);
	});
});

describe('rankNameMatches / bestAlias', () => {
	const rows = [{ name: 'Ice Tunnel' }, { name: 'Escape Tunnel' }, { name: 'Escape Tunnel' }, { name: 'Tunnel Rats' }];
	it('ranks distinct names by similarity to the OCR text', () => {
		expect(rankNameMatches(rows, 'Escave Tunnel', 3).map((m) => m.name)).toEqual(['Escape Tunnel', 'Ice Tunnel', 'Tunnel Rats']);
		expect(rankNameMatches(rows, 'Escave Tunnel', 1)).toHaveLength(1);
	});
	it('prefers the record whose canonical name matched on a tie with a face alias', () => {
		const tie = [{ name: 'Negate // Negate' }, { name: 'Negate' }];
		expect(bestNameMatch(tie, 'Negate').name).toBe('Negate');
		expect(rankNameMatches(tie, 'Negate', 2).map((m) => m.name)).toEqual(['Negate', 'Negate // Negate']);
	});
	it('reports which alias of a double-faced name matched', () => {
		expect(bestAlias('Cal', 'Beck // Call')).toEqual({ alias: 'Call', score: 0.75 });
		expect(bestAlias('Beloved Beggar', 'Beloved Beggar // Generous Soul').alias).toBe('Beloved Beggar');
	});
});

describe('resolveCard — art-hash evidence (Phase 3)', () => {
	const art = (r: ReturnType<typeof row>, distance: number, rotated = false) => ({ row: r, distance, rotated });

	it('identifies a card from an unambiguous close art match when the name channel has nothing', () => {
		const d = resolveCard(base({
			nameText: 'W Courier of Cotesiiis',
			artMatches: [art(pool[0], 6)]
		}));
		expect(d.identity).toMatchObject({ name: 'Mechanized Ninja Cavalry', state: 'confirmed' });
		expect(d.printing).toMatchObject({ row: pool[0], state: 'confirmed' });
		expect(d.reasons.join(' ')).toContain('art');
	});

	// A third Dawnhart Rejuvenator with its own artwork (a showcase frame), 63 bits from the scan below.
	const showcase = row('Dawnhart Rejuvenator', 'mid', '301', 'common', 'ffffffffffffffff');
	const withShowcase = (n: string) => (n === 'Dawnhart Rejuvenator' ? [pool[4], pool[5], showcase] : pool.filter((r) => r.name === n));

	it('narrows the printings to the ones sharing the artwork and lets the footer pick among them', () => {
		const d = resolveCard(base({
			artMatches: [art(pool[4], 1), art(pool[5], 7)], // Dawnhart Rejuvenator mid#180 and dbl#180
			artHash: '0000000000000004', printingsByName: withShowcase,
			footer: [reading({ setCode: 'mid', collectorNumber: '180', numberSource: 'fraction', rarity: 'c', text: '180/277 C MID EN' })]
		}));
		expect(d.identity).toMatchObject({ name: 'Dawnhart Rejuvenator', state: 'confirmed' });
		expect(d.printing).toMatchObject({ row: pool[4], state: 'confirmed' });
		expect(d.reasons.join(' ')).toContain('narrowed to 2 of 3');
		// without a footer the same-artwork reprint stays a candidate, the showcase with its own artwork does not
		const open = resolveCard(base({ artMatches: [art(pool[4], 1), art(pool[5], 7)], artHash: '0000000000000004', printingsByName: withShowcase }));
		expect(open.printing.state).toBe('unknown');
		expect(open.printing.candidates).toEqual([pool[4], pool[5]]);
	});

	it('never settles a printing from the hits alone: the search radius is not the set of printings with this artwork', () => {
		const d = resolveCard(base({ artMatches: [art(pool[4], 1)], artHash: '0000000000000004', printingsByName: () => [] }));
		expect(d.identity).toMatchObject({ name: 'Dawnhart Rejuvenator', state: 'confirmed' });
		expect(d.printing.state).toBe('unknown');
		expect(d.printing.candidates).toEqual([pool[4]]);
		// the name's printings known, only one hit within the radius: the reprint stays a candidate
		const known = resolveCard(base({ artMatches: [art(pool[4], 1)], artHash: '0000000000000004', printingsByName: withShowcase }));
		expect(known.printing.state).toBe('unknown');
		expect(known.printing.candidates).toEqual([pool[4], pool[5]]);
	});

	it('narrows the printings of a name-identified card by artwork as well', () => {
		const d = resolveCard(base({
			nameCandidates: [{ name: 'Dawnhart Rejuvenator', score: 0.95, pass: 'primary' }], nameText: 'Dawnhart Rejuvenator',
			artHash: '0000000000000004', printingsByName: withShowcase
		}));
		expect(d.identity).toMatchObject({ name: 'Dawnhart Rejuvenator', state: 'confirmed' });
		expect(d.printing.candidates).toEqual([pool[4], pool[5]]);
		// no scan hash: every printing stays
		const all = resolveCard(base({
			nameCandidates: [{ name: 'Dawnhart Rejuvenator', score: 0.95, pass: 'primary' }], nameText: 'Dawnhart Rejuvenator',
			printingsByName: withShowcase
		}));
		expect(all.printing.candidates).toEqual([pool[4], pool[5], showcase]);
	});

	it('beats an uncertain name that reads differently', () => {
		const d = resolveCard(base({
			nameCandidates: [{ name: 'Llanowar Cavalry', score: 0.63, pass: 'rotated binarized' }], nameText: 'pean Zia Cavalry',
			artMatches: [art(pool[0], 7)]
		}));
		expect(d.identity).toMatchObject({ name: 'Mechanized Ninja Cavalry', state: 'confirmed' });
	});

	it('raises a conflict against a certain name that reads differently', () => {
		const d = resolveCard(base({
			nameCandidates: [{ name: 'Lightning Bolt', score: 0.95, pass: 'primary' }], nameText: 'Lightning Bolt',
			artMatches: [art(pool[0], 5)]
		}));
		expect(d.identity.state).toBe('conflict');
		expect(d.printing.candidates.map((r) => r.name)).toEqual(expect.arrayContaining(['Mechanized Ninja Cavalry', 'Lightning Bolt']));
	});

	it('turns a looser match into a confirmation when a partial name agrees, but never into one tap on its own', () => {
		const agree = resolveCard(base({
			nameCandidates: [{ name: 'Dawnhart Rejuvenator', score: 0.5, pass: 'primary' }], nameText: 'Dawnhart r',
			artMatches: [art(pool[4], 12), art(pool[5], 12)]
		}));
		expect(agree.identity).toMatchObject({ name: 'Dawnhart Rejuvenator', state: 'confirmed' });
		// Against 8.5k hashes the nearest artwork at 12–14 bits was a different card in 7 of 15 cases
		// without a name to check it against: no suggestion from the artwork alone.
		const alone = resolveCard(base({ artMatches: [art(pool[0], 12)] }));
		expect(alone.identity.state).toBe('unknown');
		expect(alone.printing.candidates).toEqual([]);
	});

	it('offers ambiguous close matches of different cards for one tap, name channel deciding when it can', () => {
		const ambiguous = resolveCard(base({ artMatches: [art(pool[0], 6), art(pool[1], 8)] }));
		expect(ambiguous.identity.state).toBe('likely');
		expect(ambiguous.printing.candidates.map((r) => r.name)).toEqual(['Mechanized Ninja Cavalry', 'Llanowar Cavalry']);
		const decided = resolveCard(base({
			nameCandidates: [{ name: 'Llanowar Cavalry', score: 0.63, pass: 'primary' }], nameText: 'Llanowar Cavalry',
			artMatches: [art(pool[0], 6), art(pool[1], 8)]
		}));
		expect(decided.identity).toMatchObject({ name: 'Llanowar Cavalry', state: 'confirmed' });
	});

	it('ignores matches beyond the likely distance', () => {
		const d = resolveCard(base({ artMatches: [art(pool[0], 20)] }));
		expect(d.identity.state).toBe('unknown');
		expect(d.printing.candidates).toEqual([]);
	});
});

describe('artPool', () => {
	const a = row('X', 'aaa', '1', 'common', '0000000000000000');
	const b = row('X', 'bbb', '1', 'common', '00000000000000ff'); // the same artwork, 8 bits off
	const c = row('X', 'ccc', '1', 'common', 'ffffffffffffffff'); // a different artwork
	const n = row('X', 'ddd', '1'); // not hashed yet

	it('keeps every printing without a scan hash, without reference hashes, or when the nearest is not a close match', () => {
		expect(artPool([a, b, c, n])).toEqual([a, b, c, n]);
		expect(artPool([n], '0000000000000000')).toEqual([n]);
		expect(artPool([a, b, c, n], 'ffffffff00000000')).toEqual([a, b, c, n]); // nearest 32 bits away: nothing recognised
		expect(artPool([a, b, c, n], 'not a hash')).toEqual([a, b, c, n]);
	});

	it('drops the printings whose artwork is clearly further away than the nearest and keeps the hash-less ones', () => {
		expect(artPool([a, b, c, n], '0000000000000001')).toEqual([a, b, n]);
		expect(artPool([a, b, c, n], '0f0f0f0f0f0f0f0f', '0000000000000001')).toEqual([a, b, n]); // the rotated hash counts too
		expect(artPool([c, a], '0000000000000001')).toEqual([a]);
	});
});
