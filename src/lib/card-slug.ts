/**
 * Readable URLs for card pages (/cards/<slug>): one page per card (oracle id),
 * the printings below it keep their Scryfall-id URLs. Pure, so the slug rules are
 * unit-tested without the database; src/lib/server/card-slugs.ts feeds them.
 */

const PRINTING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Scryfall printing ids are lower-case UUIDs; a card slug never has that shape. */
export function isPrintingId(value: string): boolean {
	return PRINTING_ID.test(value);
}

// Letters NFKD does not decompose into a base letter plus accents.
const LIGATURES: Record<string, string> = { æ: 'ae', œ: 'oe', ø: 'o', ß: 'ss', đ: 'd', ł: 'l', þ: 'th', ð: 'd' };

export function slugifyCardName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[æœøßđłþð]/g, (c) => LIGATURES[c])
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/['‘’`´]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export type CardGroup = { oracleId: string; name: string; token: boolean };

/**
 * Slug per oracle id. A name shared by several cards (mostly tokens: Soldier,
 * Demon) keeps its plain slug for the one real card among them; everything else
 * in the group gets the first block of its oracle id appended, so a slug only
 * moves when a second real card with the same name appears.
 */
export function assignCardSlugs(groups: CardGroup[]): Map<string, string> {
	const byBase = new Map<string, CardGroup[]>();
	for (const g of groups) {
		const base = slugifyCardName(g.name);
		const list = byBase.get(base);
		if (list) list.push(g);
		else byBase.set(base, [g]);
	}
	const slugs = new Map<string, string>();
	for (const [base, members] of byBase) {
		const real = members.filter((m) => !m.token);
		const plain = base && (members.length === 1 || real.length === 1) ? (members.length === 1 ? members[0] : real[0]) : null;
		for (const m of members) {
			const suffix = m.oracleId.split('-')[0];
			slugs.set(m.oracleId, m === plain ? base : base ? `${base}-${suffix}` : `card-${suffix}`);
		}
	}
	return new Map(groups.map((g) => [g.oracleId, slugs.get(g.oracleId)!]));
}
