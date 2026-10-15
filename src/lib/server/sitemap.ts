import { SITE_URL } from '../seo';

export const SITEMAP_PAGE_SIZE = 10_000;
const STATIC_PATHS = ['/', '/cards', '/scan', '/contact', '/impressum', '/datenschutz'];
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';
const XML_NAMESPACE = 'http://www.sitemaps.org/schemas/sitemap/0.9';

function escapeXml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Card pages only (one per card, see card-slugs.ts). The ~115k printing pages point
// to them by canonical: Google left 108k of the printing URLs "discovered - currently
// not indexed" (Search Console, 2026-10), and near-identical printings dilute a new domain.
export function sitemapIndex(cardSlugs: readonly string[]): string {
	const parts = ['pages', ...Array.from({ length: Math.ceil(cardSlugs.length / SITEMAP_PAGE_SIZE) }, (_, i) => `cards-${i + 1}`)];
	return `${XML_HEADER}<sitemapindex xmlns="${XML_NAMESPACE}">\n${parts.map(part =>
		`<sitemap><loc>${SITE_URL}/sitemap-${part}.xml</loc></sitemap>`).join('\n')}\n</sitemapindex>`;
}

export function sitemapPart(cardSlugs: readonly string[], part: string): string | null {
	let paths: string[];
	if (part === 'pages') {
		paths = STATIC_PATHS;
	} else {
		const match = /^cards-([1-9]\d*)$/.exec(part);
		if (!match) return null;
		const page = Number(match[1]);
		if (!Number.isSafeInteger(page) || page > Math.ceil(cardSlugs.length / SITEMAP_PAGE_SIZE)) return null;
		// The slug list is ordered by oracle id, so a new card only shifts the parts after it.
		paths = cardSlugs.slice((page - 1) * SITEMAP_PAGE_SIZE, page * SITEMAP_PAGE_SIZE)
			.map(slug => `/cards/${encodeURIComponent(slug)}`);
	}
	// No invented modification dates: the catalogue has no content-updated timestamp.
	return `${XML_HEADER}<urlset xmlns="${XML_NAMESPACE}">\n${paths.map(path =>
		`<url><loc>${escapeXml(SITE_URL + path)}</loc></url>`).join('\n')}\n</urlset>`;
}

export function sitemapResponse(xml: string): Response {
	return new Response(xml, { headers: {
		'Content-Type': 'application/xml; charset=utf-8',
		'Cache-Control': 'public, max-age=3600'
	} });
}
