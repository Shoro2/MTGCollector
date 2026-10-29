import { SITE_URL } from '../seo';

export const SITEMAP_PAGE_SIZE = 10_000;
const STATIC_PATHS = ['/', '/cards', '/decks', '/scan', '/portfolio-tracker', '/contact', '/impressum', '/datenschutz'];
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';
const XML_NAMESPACE = 'http://www.sitemaps.org/schemas/sitemap/0.9';

function escapeXml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** A deck search engines may index (indexableDecks() in decks.ts); `updated_at` is ISO 8601. */
export type SitemapDeck = { id: string; updated_at: string };

const partCount = (items: number) => Math.ceil(items / SITEMAP_PAGE_SIZE);

// Card pages only (one per card, see card-slugs.ts). The ~115k printing pages point
// to them by canonical: Google left 108k of the printing URLs "discovered - currently
// not indexed" (Search Console, 2026-10), and near-identical printings dilute a new domain.
// Public decks follow in their own parts (owner decision 2026-10-29), only the indexable ones.
export function sitemapIndex(cardSlugs: readonly string[], decks: readonly SitemapDeck[] = []): string {
	const parts = ['pages',
		...Array.from({ length: partCount(cardSlugs.length) }, (_, i) => `cards-${i + 1}`),
		...Array.from({ length: partCount(decks.length) }, (_, i) => `decks-${i + 1}`)];
	return `${XML_HEADER}<sitemapindex xmlns="${XML_NAMESPACE}">\n${parts.map(part =>
		`<sitemap><loc>${SITE_URL}/sitemap-${part}.xml</loc></sitemap>`).join('\n')}\n</sitemapindex>`;
}

export function sitemapPart(cardSlugs: readonly string[], part: string, decks: readonly SitemapDeck[] = []): string | null {
	let entries: { path: string; lastmod?: string }[];
	if (part === 'pages') {
		entries = STATIC_PATHS.map(path => ({ path }));
	} else {
		const match = /^(cards|decks)-([1-9]\d*)$/.exec(part);
		if (!match) return null;
		const page = Number(match[2]);
		const items = match[1] === 'cards' ? cardSlugs.length : decks.length;
		if (!Number.isSafeInteger(page) || page > partCount(items)) return null;
		const range = [(page - 1) * SITEMAP_PAGE_SIZE, page * SITEMAP_PAGE_SIZE] as const;
		// The slug list is ordered by oracle id, so a new card only shifts the parts after it.
		// No invented modification dates for cards: the catalogue has no content-updated timestamp.
		// A deck has one: every change to it or its cards sets updated_at.
		entries = match[1] === 'cards'
			? cardSlugs.slice(...range).map(slug => ({ path: `/cards/${encodeURIComponent(slug)}` }))
			: decks.slice(...range).map(deck => ({ path: `/decks/${encodeURIComponent(deck.id)}`, lastmod: deck.updated_at }));
	}
	return `${XML_HEADER}<urlset xmlns="${XML_NAMESPACE}">\n${entries.map(({ path, lastmod }) =>
		`<url><loc>${escapeXml(SITE_URL + path)}</loc>${lastmod ? `<lastmod>${escapeXml(lastmod)}</lastmod>` : ''}</url>`).join('\n')}\n</urlset>`;
}

export function sitemapResponse(xml: string): Response {
	return new Response(xml, { headers: {
		'Content-Type': 'application/xml; charset=utf-8',
		'Cache-Control': 'public, max-age=3600'
	} });
}
