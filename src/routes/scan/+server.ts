import { json } from '@sveltejs/kit';
import { searchByName, searchBySetNumber } from '$lib/server/card-search';

type Lookup = { setCode: string; collectorNumber: string };

function isLookup(x: unknown): x is Lookup {
	return !!x
		&& typeof (x as Lookup).setCode === 'string'
		&& typeof (x as Lookup).collectorNumber === 'string';
}

export async function POST({ request }) {
	const body = await request.json();

	// Batch name form: { queries: string[] } → { batch: SearchResult[] }
	if (Array.isArray(body?.queries)) {
		const queries = (body.queries as unknown[])
			.filter((q): q is string => typeof q === 'string')
			.slice(0, 50);
		const batch = queries.map((q) => ({ query: q, ...searchByName(q) }));
		return json({ batch });
	}

	// Batch set+number form: { lookups: [{setCode, collectorNumber}, ...] }
	// Used by the scanner fallback when name OCR failed completely — we'd
	// otherwise round-trip once per card.
	if (Array.isArray(body?.lookups)) {
		const lookups = (body.lookups as unknown[]).filter(isLookup).slice(0, 50);
		const batch = lookups.map((l) => ({
			setCode: l.setCode,
			collectorNumber: l.collectorNumber,
			...searchBySetNumber(l.setCode, l.collectorNumber)
		}));
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
