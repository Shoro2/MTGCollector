import { json } from '@sveltejs/kit';
import { searchByName, searchBySetNumber } from '$lib/server/card-search';

export async function POST({ request }) {
	const body = await request.json();
	const { query, setCode, collectorNumber } = body;

	if (setCode && collectorNumber) {
		return json(searchBySetNumber(String(setCode), String(collectorNumber)));
	}

	if (!query || typeof query !== 'string' || query.trim().length < 2) {
		return json({ results: [] });
	}

	return json(searchByName(query));
}
