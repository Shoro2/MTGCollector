import { json } from '@sveltejs/kit';
import { searchByName, searchBySetNumber, printingsByName, isKnownSet, nearBySetNumber, cardsById, withPrinted } from '$lib/server/card-search';
import { searchArt, type ArtSearchHit } from '$lib/server/art-index';
import type { CardRow } from '$lib/server/card-search';
import { ART_LIKELY } from '$lib/scanner/resolve';

type Lookup = { setCode: string; collectorNumber: string };

function isLookup(x: unknown): x is Lookup {
	return !!x
		&& typeof (x as Lookup).setCode === 'string'
		&& typeof (x as Lookup).collectorNumber === 'string';
}

export async function POST({ request }) {
	let body: Record<string, unknown>;
	try {
		const parsed = await request.json();
		body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch {
		// Malformed JSON — return an empty result with 400 rather than a 500.
		return json({ results: [], matchType: 'none' }, { status: 400 });
	}

	// Batch name form: { queries: string[] } → { batch: SearchResult[] }
	if (Array.isArray(body.queries)) {
		const queries = (body.queries as unknown[])
			.filter((q): q is string => typeof q === 'string')
			.slice(0, 50);
		const batch = queries.map((q) => {
			const r = searchByName(q);
			return { query: q, ...r, results: withPrinted(r.results) };
		});
		return json({ batch });
	}

	// Batch set+number form: { lookups: [{setCode, collectorNumber}, ...] }
	// Used by the scanner's evidence fusion — one round trip for every footer
	// reading of a scan. `setKnown` tells the client whether the set code is
	// real (a garbage code weakens the reading); an empty collector number
	// only answers that question.
	if (Array.isArray(body.lookups)) {
		const lookups = (body.lookups as unknown[]).filter(isLookup).slice(0, 100);
		const batch = lookups.map((l) => {
			const r = l.collectorNumber ? searchBySetNumber(l.setCode, l.collectorNumber) : { results: [], matchType: 'none' as const };
			return { setCode: l.setCode, collectorNumber: l.collectorNumber, setKnown: isKnownSet(l.setCode), ...r, results: withPrinted(r.results) };
		});
		return json({ batch });
	}

	// Batch near-number form: { near: [{setCode, collectorNumber, rarity}, ...] }
	// -> printings one OCR error away from the read number, rarity-filtered.
	if (Array.isArray(body.near)) {
		const near = (body.near as unknown[]).filter(isLookup).slice(0, 100) as Array<Lookup & { rarity?: unknown }>;
		const batch = near.map((l) => ({
			setCode: l.setCode,
			collectorNumber: l.collectorNumber,
			rarity: typeof l.rarity === 'string' ? l.rarity : '',
			results: withPrinted(nearBySetNumber(l.setCode, l.collectorNumber, typeof l.rarity === 'string' ? l.rarity : ''))
		}));
		return json({ batch });
	}

	// Batch art form: { artHashes: [{ hash, alt? }, ...] } -> the printings whose
	// reference art hash lies within ART_LIKELY bits of the scanned card's art
	// (Phase 3; `alt` is the hash of the 180°-rotated warp), nearest first, with
	// the distance. The Hamming scan runs here over the in-memory index; the
	// phone never downloads the table.
	if (Array.isArray(body.artHashes)) {
		const items = (body.artHashes as unknown[])
			.filter((x): x is { hash: string; alt?: unknown } => !!x && typeof (x as { hash?: unknown }).hash === 'string')
			.slice(0, 50);
		const batch = items.map((it) => {
			const hits = searchArt(it.hash, typeof it.alt === 'string' ? it.alt : undefined, ART_LIKELY, 12);
			const rows = cardsById(hits.map((h) => h.id));
			withPrinted([...rows.values()]);
			const matches: Array<ArtSearchHit & { row: CardRow }> = [];
			for (const h of hits) {
				const row = rows.get(h.id);
				if (row) matches.push({ ...h, row });
			}
			return { hash: it.hash, matches };
		});
		return json({ batch });
	}

	// Batch printings form: { printings: string[] } -> every printing of each
	// canonical name, so reprint resolution sees the whole list instead of the
	// ten newest rows the name search returns.
	if (Array.isArray(body.printings)) {
		const names = (body.printings as unknown[]).filter((n): n is string => typeof n === 'string').slice(0, 50);
		const batch = names.map((name) => ({ name, results: withPrinted(printingsByName(name)) }));
		return json({ batch });
	}

	const { query, setCode, collectorNumber } = body;

	if (typeof setCode === 'string' && typeof collectorNumber === 'string') {
		const r = searchBySetNumber(setCode, collectorNumber);
		return json({ ...r, results: withPrinted(r.results) });
	}

	if (typeof query !== 'string' || query.trim().length < 2) {
		return json({ results: [], matchType: 'none' });
	}

	const r = searchByName(query);
	return json({ ...r, results: withPrinted(r.results) });
}
