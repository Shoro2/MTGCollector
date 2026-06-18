import { json } from '@sveltejs/kit';
import { searchByName, searchBySetNumber } from '$lib/server/card-search';

export async function POST({ request }) {
	let body: Record<string, unknown>;
	try {
		const parsed = await request.json();
		body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch {
		// Malformed JSON — return an empty result with 400 rather than a 500.
		return json({ results: [] }, { status: 400 });
	}
	const { query, setCode, collectorNumber } = body;

	if (typeof setCode === 'string' && typeof collectorNumber === 'string') {
		return json(searchBySetNumber(setCode, collectorNumber));
	}

	if (typeof query !== 'string' || query.trim().length < 2) {
		return json({ results: [] });
	}

	return json(searchByName(query));
}
