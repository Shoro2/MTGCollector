import { afterEach, describe, expect, it } from 'vitest';
import { bestPrefixAlias, prefixDistances, prefixIdentifies, prefixNameScore, prefixScore, rankPrefixMatches, startShares, stripLeadingToken } from './name-prefix';
import { bigramsOf, normalizeName, setPrintedAliasSource } from './similarity';
import { resolveCard, type FooterReading, type ResolveInput } from './resolve';

describe('prefixDistances', () => {
	it('gives the edit distance of the text to every prefix of the alias', () => {
		expect(prefixDistances('abc', 'abcdef')[0]).toEqual([3, 2, 1, 0, 1, 2]);
	});
	it('adds rows for the text without its last characters', () => {
		const rows = prefixDistances('abx', 'abcd', 1);
		expect(rows).toHaveLength(2);
		expect(rows[0][2]).toBe(1); // "abx" vs "ab"
		expect(rows[1][2]).toBe(0); // "ab" vs "ab"
	});
});

describe('prefixScore', () => {
	it('scores the visible start of a name as a full match', () => {
		expect(prefixScore('Lightning B', 'Lightning Bolt')).toBe(1);
		expect(prefixScore('Dawnhart Rej', 'Dawnhart Rejuvenator')).toBe(1);
		expect(prefixScore('Kriegsh', 'Kriegshorn')).toBe(1);
	});
	it('tolerates a misread letter and a cut-through last letter', () => {
		expect(prefixScore('Lightnmg Bo', 'Lightning Bolt')).toBeGreaterThan(0.8);
		expect(prefixScore('Kriegshl', 'Kriegshorn')).toBeGreaterThan(0.9);
		expect(prefixScore('Smotherinq Til', 'Smothering Tithe')).toBeGreaterThan(0.85);
	});
	it('scores a fully visible name like the whole-string comparison', () => {
		expect(prefixScore('Shock', 'Shock')).toBe(1);
		expect(prefixScore('Lightning Bolt', 'Lightning Bolt')).toBe(1);
	});
	it('ranks a different start low', () => {
		expect(prefixScore('Dawnhart Rej', 'Dawnhart Geist')).toBeLessThan(prefixScore('Dawnhart Rej', 'Dawnhart Rejuvenator'));
		expect(prefixScore('Lightning B', 'Llanowar Elves')).toBeLessThan(0.4);
	});
	it('writes off a short token before the name: the card edge read as a letter', () => {
		expect(stripLeadingToken('l punk')).toBe('punk');
		expect(stripLeadingToken('fl rotter')).toBe('rotter');
		expect(stripLeadingToken('lightning b')).toBe('lightning b');
		expect(prefixScore('l Punk', 'Punk Frogs')).toBeGreaterThan(0.85);
		expect(prefixScore('fl Rotter', 'Rotten Reunion')).toBeGreaterThan(0.8);
		expect(prefixScore('i Bot', 'Bot Bashing Time')).toBeGreaterThan(0.8);
		// a name that starts with a short word keeps it
		expect(prefixScore('A Little Ch', 'A Little Chat')).toBe(1);
		expect(prefixScore('A Little Ch', 'Little Girl')).toBeLessThan(prefixScore('A Little Ch', 'A Little Chat'));
	});
	it('says nothing about texts with fewer than three letters', () => {
		expect(prefixScore('Xy', 'Xyris, the Writhing Storm')).toBe(0);
		expect(prefixScore('12 3', '1996 World Champion')).toBe(0);
	});
});

describe('aliases and ranking', () => {
	afterEach(() => setPrintedAliasSource(null));

	it('matches a face of a double-faced card and a printed German name', () => {
		expect(prefixNameScore('Generous S', 'Beloved Beggar // Generous Soul')).toBe(1);
		setPrintedAliasSource((name) => (name === 'War Horn' ? [{ alias: 'Kriegshorn', lang: 'de' }] : []));
		expect(bestPrefixAlias('Kriegsh', 'War Horn')).toEqual({ alias: 'Kriegshorn', score: 1 });
		expect(rankPrefixMatches([{ name: 'War Horn' }], 'Kriegsh')[0]).toEqual({ name: 'War Horn', score: 1, lang: 'de' });
	});
	it('ranks names by their start, the shorter name first on a tie', () => {
		const rows = ['Lightning Berserker', 'Lightning Bolt', 'Llanowar Elves', 'Lightning Bolt'].map((name) => ({ name }));
		const ranked = rankPrefixMatches(rows, 'Lightning B');
		expect(ranked.map((r) => r.name)).toEqual(['Lightning Bolt', 'Lightning Berserker', 'Llanowar Elves']);
	});
});

describe('prefixIdentifies', () => {
	const rows = ['Lightning Bolt', 'Lightning Blast', 'Lightning Berserker', 'Lightning Helix', 'Lightning Axe'].map((name) => ({ name }));
	it('never identifies a start several names share', () => {
		const ranked = rankPrefixMatches(rows, 'Lightning Bo');
		expect(ranked[0].name).toBe('Lightning Bolt');
		expect(prefixIdentifies(ranked[0], ranked, 'Lightning Bo')).toBe(false);
	});
	it('identifies a long, unique start', () => {
		const all = [...rows, { name: 'Dawnhart Rejuvenator' }, { name: 'Dawnhart Geist' }];
		const ranked = rankPrefixMatches(all, 'Dawnhart Rejuv');
		expect(prefixIdentifies(ranked[0], ranked, 'Dawnhart Rejuv')).toBe(true);
		// one distinguishing letter (and a cut-through one) is not enough: "Rej" against "Gei" is one misread away
		const short = rankPrefixMatches(all, 'Dawnhart Rej');
		expect(prefixIdentifies(short[0], short, 'Dawnhart Rej')).toBe(false);
	});
	it('needs enough letters', () => {
		const ranked = rankPrefixMatches([{ name: 'Lightning Bolt' }], 'Light');
		expect(prefixIdentifies(ranked[0], ranked, 'Light')).toBe(false);
	});
	it('identifies a whole name read exactly from five letters on, when nothing else starts that way', () => {
		const alone = rankPrefixMatches([{ name: 'Nobody' }], 'Nobody');
		expect(prefixIdentifies(alone[0], alone, 'Nobody')).toBe(true);
		expect(prefixIdentifies(alone[0], alone, 'l Nobody')).toBe(true);
		const shared = rankPrefixMatches([{ name: 'Forest' }, { name: 'Forest Bear' }, { name: 'Forested Overlook' }], 'Forest');
		expect(prefixIdentifies(shared[0], shared, 'Forest')).toBe(false);
		const short = rankPrefixMatches([{ name: 'Opt' }], 'Opt');
		expect(prefixIdentifies(short[0], short, 'Opt')).toBe(false);
	});
});

describe('startShares', () => {
	it('keeps names that start like the text and skips the rest', () => {
		const qb = [...bigramsOf(normalizeName('Lightning B'))];
		expect(startShares(qb, normalizeName('Lightning Bolt'), 11)).toBe(true);
		expect(startShares(qb, normalizeName('Sol Ring'), 11)).toBe(false);
		// the text's bigrams far into a long name do not count
		expect(startShares(qb, normalizeName('Ajani, Wise Counsellor of the Lightning Blade'), 11)).toBe(false);
	});
});

describe('resolveCard with a truncated name bar', () => {
	const row = (name: string, set: string, num: string, rarity = 'common') => ({ id: `${set}-${num}`, name, set_code: set, collector_number: num, rarity });
	const db = [
		row('Lightning Bolt', 'm10', '146'), row('Lightning Bolt', 'lea', '161'), row('Lightning Blast', 'm10', '147'),
		row('Lightning Berserker', 'dtk', '146', 'uncommon'), row('Dawnhart Rejuvenator', 'mid', '180'), row('Dawnhart Geist', 'mid', '8', 'uncommon'),
		row('Cathar Commando', 'mid', '10'), row("Cathar's Call", 'soi', '2', 'uncommon'), row('Bot Bashing Time', 'tmt', '85')
	];
	const reading = (o: Partial<FooterReading>): FooterReading => ({
		setCode: '', collectorNumber: '', numberSource: 'none', rarity: '', language: 'EN', foilFromText: false, variant: 'primary', trustFoil: false, text: '', ...o
	});
	const candidates = (text: string) => rankPrefixMatches(db, text).map((c) => ({ ...c, pass: 'prefix' }));
	const base = (o: Partial<ResolveInput>): ResolveInput => ({
		nameCandidates: [], nameText: '', footer: [], majoritySet: null, nameTruncated: true,
		printingsByName: (n) => db.filter((r) => r.name === n),
		lookup: (s, n) => db.filter((r) => r.set_code === s.toLowerCase() && r.collector_number === n.replace(/^0+/, '')),
		isKnownSet: (s) => ['m10', 'lea', 'dtk', 'mid', 'soi', 'tmt'].includes(s.toLowerCase()),
		...o
	});
	// the server's scan of a whole set (prefixInSet in card-search.ts)
	const inSet = (text: string) => (set: string) => db.filter((r) => r.set_code === set && prefixNameScore(text, r.name) >= 0.6);

	it('never confirms a shared start without the footer', () => {
		const d = resolveCard(base({ nameText: 'Lightning B', nameCandidates: candidates('Lightning B') }));
		expect(d.identity.state).not.toBe('confirmed');
	});
	it('lets the footer pick among the names that share the start', () => {
		const d = resolveCard(base({
			nameText: 'Lightning B', nameCandidates: candidates('Lightning B'),
			footer: [reading({ setCode: 'm10', collectorNumber: '147', numberSource: 'rarity', rarity: 'c', text: 'C 0147 M10 EN' })]
		}));
		expect(d.identity).toMatchObject({ name: 'Lightning Blast', state: 'confirmed' });
		expect(d.printing).toMatchObject({ state: 'confirmed', row: db[2] });
	});
	it('offers a choice when a number fits printings of two names that share the start', () => {
		// "146" without a set: Lightning Bolt M10 #146 and Lightning Berserker DTK #146
		const d = resolveCard(base({
			nameText: 'Lightning B', nameCandidates: candidates('Lightning B'),
			footer: [reading({ collectorNumber: '146', numberSource: 'fraction', text: '146/249' })]
		}));
		expect(d.identity.state).toBe('likely');
		expect(d.printing.candidates.map((r) => r.id)).toEqual(expect.arrayContaining(['m10-146', 'dtk-146']));
	});
	it('identifies a long unique start and lets the footer pick the printing', () => {
		const d = resolveCard(base({ nameText: 'Dawnhart Rejuv', nameCandidates: candidates('Dawnhart Rejuv') }));
		expect(d.identity).toMatchObject({ name: 'Dawnhart Rejuvenator', state: 'confirmed' });
		expect(d.printing.state).toBe('confirmed');
	});
	it('lets a strong reading of another card that starts the same way beat a seemingly unique start', () => {
		// a candidate list that lacks the rival (a search that missed it) must not overrule the footer
		const d = resolveCard(base({
			nameText: 'Lightning B', nameCandidates: [{ name: 'Lightning Blast', score: 1, pass: 'prefix' }],
			footer: [reading({ setCode: 'lea', collectorNumber: '161', numberSource: 'fraction', text: '161 LEA' })]
		}));
		expect(d.identity).toMatchObject({ name: 'Lightning Bolt', state: 'confirmed' });
		expect(d.printing.row).toEqual(db[1]);
	});
	it('identifies a start that only one name of the read set has, when the line shows no number', () => {
		const d = resolveCard(base({
			nameText: 'Catha', nameCandidates: candidates('Catha'), prefixInSet: inSet('Catha'),
			footer: [reading({ setCode: 'MID', language: 'EN', text: 'MID EN Artist' })]
		}));
		expect(d.identity).toMatchObject({ name: 'Cathar Commando', state: 'confirmed' });
		expect(d.printing).toMatchObject({ state: 'confirmed', row: db[6] });
		// without the set the start is shared ("Cathar's Call")
		expect(resolveCard(base({ nameText: 'Catha', nameCandidates: candidates('Catha'), prefixInSet: inSet('Catha') })).identity.state).not.toBe('confirmed');
	});
	it('offers a start several names of the set share, or a very short one, for one tap', () => {
		const shared = resolveCard(base({
			nameText: 'Lightnin', nameCandidates: candidates('Lightnin'), prefixInSet: inSet('Lightnin'),
			footer: [reading({ setCode: 'M10', language: 'EN', text: 'M10 * EN' })]
		}));
		expect(shared.identity.state).toBe('likely');
		expect(shared.printing.candidates.map((r) => r.id)).toEqual(expect.arrayContaining(['m10-146', 'm10-147']));
		const short = resolveCard(base({
			nameText: 'Bot', nameCandidates: candidates('Bot'), prefixInSet: inSet('Bot'),
			footer: [reading({ setCode: 'TMT', language: 'EN', text: 'TMT EN' })]
		}));
		expect(short.identity).toMatchObject({ name: 'Bot Bashing Time', state: 'likely' });
	});
	it('offers the majority set of the scan for one tap, never more', () => {
		const d = resolveCard(base({ nameText: 'Catha', nameCandidates: candidates('Catha'), prefixInSet: inSet('Catha'), majoritySet: 'mid' }));
		expect(d.identity).toMatchObject({ name: 'Cathar Commando', state: 'likely' });
	});
	it('leaves a collector line with a number, or with two set codes, to the other rules', () => {
		// "8" is Dawnhart Geist's number: the footer, not the start of the name inside the set, decides
		const numbered = resolveCard(base({
			nameText: 'Catha', nameCandidates: candidates('Catha'), prefixInSet: inSet('Catha'),
			footer: [reading({ setCode: 'MID', collectorNumber: '8', numberSource: 'fraction', rarity: 'u', text: '008/277 U MID EN' })]
		}));
		expect(numbered.identity.name).not.toBe('Cathar Commando');
		const twoSets = resolveCard(base({
			nameText: 'Catha', nameCandidates: candidates('Catha'), prefixInSet: inSet('Catha'),
			footer: [reading({ setCode: 'MID', text: 'MID EN' }), reading({ setCode: 'SOI', variant: 'small', text: 'SOI EN' })]
		}));
		expect(twoSets.identity.state).not.toBe('confirmed');
	});
	it('confirms the start and the exact footer of the same card', () => {
		const d = resolveCard(base({
			nameText: 'Lightning B', nameCandidates: candidates('Lightning B'),
			footer: [reading({ setCode: 'lea', collectorNumber: '161', numberSource: 'fraction', text: '161 LEA' })]
		}));
		expect(d.identity).toMatchObject({ name: 'Lightning Bolt', state: 'confirmed' });
		expect(d.printing).toMatchObject({ state: 'confirmed', row: db[1] });
	});
});

describe('resolveCard: a footer misread against a truncated name bar', () => {
	const row = (name: string, set: string, num: string) => ({ id: `${set}-${num}`, name, set_code: set, collector_number: num, rarity: 'common' });
	// the harness catalogue plants a printing at every plausible misread of a number
	const db = [row('Giant Growth', 'm10', '184'), row('Distractor M10 #104', 'm10', '104')];
	it('does not let an unrelated name that the start barely fits beat the name', () => {
		// "l Giant Grc" reaches 0.45 against "Distractor M10 #104" at its best prefix length
		expect(prefixNameScore('l Giant Grc', 'Distractor M10 #104')).toBeGreaterThan(0.4);
		const d = resolveCard({
			nameCandidates: rankPrefixMatches(db, 'l Giant Grc').map((c) => ({ ...c, pass: 'prefix' })),
			nameText: 'l Giant Grc',
			nameTruncated: true,
			footer: [{ setCode: 'M10', collectorNumber: '104', numberSource: 'fraction', rarity: 'c', language: 'EN', foilFromText: false, variant: 'primary', trustFoil: false, text: 'r3 104/249 C M10 EN' }],
			majoritySet: null,
			printingsByName: (n) => db.filter((r) => r.name === n),
			lookup: (s, n) => db.filter((r) => r.set_code === s.toLowerCase() && r.collector_number === n),
			isKnownSet: (s) => s.toLowerCase() === 'm10'
		});
		expect(d.identity.name).toBe('Giant Growth');
		expect(d.printing.row?.collector_number).not.toBe('104');
	});
});
