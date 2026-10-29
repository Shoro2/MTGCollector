import { sqlite } from '$lib/server/db';
import { cardSlugIndex } from '$lib/server/card-slugs';
import { indexableDecks } from '$lib/server/decks';
import { sitemapIndex, sitemapResponse } from '$lib/server/sitemap';

export function GET() {
	return sitemapResponse(sitemapIndex(cardSlugIndex(sqlite).slugs, indexableDecks(sqlite)));
}
