import { json } from '@sveltejs/kit';
import { searchByName, searchBySetNumber } from '$lib/server/card-search';

export async function POST({ request }) {
	const body = await request.json();

	// Batch form: { queries: string[] } → { batch: SearchResult[] }
	if (Array.isArray(body?.queries)) {
		const queries = (body.queries as unknown[])
			.filter((q): q is string => typeof q === 'string')
			.slice(0, 50); // cap to avoid abuse
		const batch = queries.map((q) => ({ query: q, ...searchByName(q) }));
		return json({ batch });
	}

	const { query, setCode, collectorNumber } = body;

	if (setCode && collectorNumber) {
		return json(searchBySetNumber(String(setCode), String(collectorNumber)));
	}

	if (!query || typeof query !== 'string') {
		return json({ results: [], matchType: 'none' });
	}

	return json(searchByName(query));
}
