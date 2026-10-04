import type Database from 'better-sqlite3';
import { SITE_URL } from '../seo';

export const SITEMAP_PAGE_SIZE = 10_000;
const STATIC_PATHS = ['/', '/cards', '/scan', '/contact', '/impressum', '/datenschutz'];
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';
const XML_NAMESPACE = 'http://www.sitemaps.org/schemas/sitemap/0.9';

function escapeXml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function cardCount(db: Database.Database): number {
	return (db.prepare('SELECT COUNT(*) AS count FROM cards').get() as { count: number }).count;
}

export function sitemapIndex(db: Database.Database): string {
	const parts = ['pages', ...Array.from({ length: Math.ceil(cardCount(db) / SITEMAP_PAGE_SIZE) }, (_, i) => `cards-${i + 1}`)];
	return `${XML_HEADER}<sitemapindex xmlns="${XML_NAMESPACE}">\n${parts.map(part =>
		`<sitemap><loc>${SITE_URL}/sitemap-${part}.xml</loc></sitemap>`).join('\n')}\n</sitemapindex>`;
}

export function sitemapPart(db: Database.Database, part: string): string | null {
	let paths: string[];
	if (part === 'pages') {
		paths = STATIC_PATHS;
	} else {
		const match = /^cards-([1-9]\d*)$/.exec(part);
		if (!match) return null;
		const page = Number(match[1]);
		if (!Number.isSafeInteger(page) || page > Math.ceil(cardCount(db) / SITEMAP_PAGE_SIZE)) return null;
		// The primary-key index supplies a stable order; never sort the entire catalogue by name.
		const cards = db.prepare('SELECT id FROM cards ORDER BY id LIMIT ? OFFSET ?')
			.all(SITEMAP_PAGE_SIZE, (page - 1) * SITEMAP_PAGE_SIZE) as { id: string }[];
		paths = cards.map(card => `/cards/${encodeURIComponent(card.id)}`);
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
