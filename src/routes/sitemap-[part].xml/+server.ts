import { error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { cardSlugIndex } from '$lib/server/card-slugs';
import { sitemapPart, sitemapResponse } from '$lib/server/sitemap';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	const xml = sitemapPart(cardSlugIndex(sqlite).slugs, params.part);
	if (xml === null) error(404, 'Sitemap not found');
	return sitemapResponse(xml);
};
