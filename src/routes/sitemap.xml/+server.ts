import { sqlite } from '$lib/server/db';
import { sitemapIndex, sitemapResponse } from '$lib/server/sitemap';

export function GET() {
	return sitemapResponse(sitemapIndex(sqlite));
}
