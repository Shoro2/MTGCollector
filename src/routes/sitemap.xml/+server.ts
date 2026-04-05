import { sqlite } from '$lib/server/db';

const BASE_URL = 'https://mtg-collector.com';

const staticPages = [
	{ loc: '/', changefreq: 'daily', priority: '1.0' },
	{ loc: '/cards', changefreq: 'daily', priority: '0.9' },
	{ loc: '/scan', changefreq: 'monthly', priority: '0.7' },
	{ loc: '/impressum', changefreq: 'yearly', priority: '0.2' },
	{ loc: '/datenschutz', changefreq: 'yearly', priority: '0.2' }
];

export async function GET() {
	const cards = sqlite
		.prepare('SELECT id FROM cards ORDER BY name')
		.all() as Array<{ id: string }>;

	let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
	xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

	for (const page of staticPages) {
		xml += `  <url>\n`;
		xml += `    <loc>${BASE_URL}${page.loc}</loc>\n`;
		xml += `    <changefreq>${page.changefreq}</changefreq>\n`;
		xml += `    <priority>${page.priority}</priority>\n`;
		xml += `  </url>\n`;
	}

	for (const card of cards) {
		xml += `  <url>\n`;
		xml += `    <loc>${BASE_URL}/cards/${card.id}</loc>\n`;
		xml += `    <changefreq>weekly</changefreq>\n`;
		xml += `    <priority>0.7</priority>\n`;
		xml += `  </url>\n`;
	}

	xml += '</urlset>';

	return new Response(xml, {
		headers: {
			'Content-Type': 'application/xml',
			'Cache-Control': 'max-age=3600'
		}
	});
}
