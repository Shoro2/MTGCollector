import { sqlite } from '$lib/server/db';
import { error, redirect } from '@sveltejs/kit';
import { setsCache } from '$lib/server/cache';
import { ftsPrefixQuery } from '$lib/fts';
import { cardSlugIndex } from '$lib/server/card-slugs';
import { queryCatalogue, userMarks } from '$lib/server/catalogue';

export async function load({ url, locals }) {
	// One tile per card is the default since 2026-11-09; the old "Unique only" switch is gone.
	if (url.searchParams.has('unique')) {
		const params = new URLSearchParams(url.searchParams);
		params.delete('unique');
		redirect(301, `/cards${params.size ? `?${params}` : ''}`);
	}
	const query = (url.searchParams.get('q') || '').trim();
	const colors = url.searchParams.getAll('color');
	const colorMode = url.searchParams.get('colorMode') || 'include';
	const type = url.searchParams.get('type') || '';
	const setCode = url.searchParams.get('set') || '';
	const rarity = url.searchParams.get('rarity') || '';
	const cmcMin = url.searchParams.get('cmcMin');
	const cmcMax = url.searchParams.get('cmcMax');
	const legality = url.searchParams.get('legality') || '';
	const sortBy = url.searchParams.get('sort') || 'name';
	const sortDir = url.searchParams.get('dir') || 'asc';
	const printings = url.searchParams.get('printings') === '1';
	const pageParam = url.searchParams.get('page') || '1';
	const page = Number(pageParam);
	if (!/^\d+$/.test(pageParam) || !Number.isSafeInteger(page) || page < 1) error(404, 'Page not found');
	const validPageSizes = [40, 75, 100, 200];
	const pageSizeParam = parseInt(url.searchParams.get('pageSize') || '40');
	const pageSize = validPageSizes.includes(pageSizeParam) ? pageSizeParam : 40;
	const offset = (page - 1) * pageSize;

	const conditions: string[] = [];
	const params: (string | number)[] = [];

	// Full-text search
	const ftsQuery = ftsPrefixQuery(query);
	if (ftsQuery) {
		conditions.push(`cards.rowid IN (SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?)`);
		params.push(ftsQuery);
	}

	// Color filter (using json_each for proper JSON array querying)
	if (colors.length > 0) {
		if (colorMode === 'exact') {
			// Exact: card has exactly these colors
			for (const c of colors) {
				conditions.push(`EXISTS (SELECT 1 FROM json_each(cards.colors) WHERE json_each.value = ?)`);
				params.push(c);
			}
			conditions.push(`json_array_length(cards.colors) = ?`);
			params.push(colors.length);
		} else if (colorMode === 'at_most') {
			// At most: card colors are a subset
			const allColors = ['W', 'U', 'B', 'R', 'G'];
			const excluded = allColors.filter((c) => !colors.includes(c));
			for (const c of excluded) {
				conditions.push(`NOT EXISTS (SELECT 1 FROM json_each(cards.colors) WHERE json_each.value = ?)`);
				params.push(c);
			}
		} else {
			// Include: card has at least these colors
			for (const c of colors) {
				conditions.push(`EXISTS (SELECT 1 FROM json_each(cards.colors) WHERE json_each.value = ?)`);
				params.push(c);
			}
		}
	}

	// Type filter
	if (type) {
		conditions.push(`cards.type_line LIKE ?`);
		params.push(`%${type}%`);
	}

	// Set filter
	if (setCode) {
		conditions.push(`cards.set_code = ?`);
		params.push(setCode);
	}

	// Rarity filter
	if (rarity) {
		conditions.push(`cards.rarity = ?`);
		params.push(rarity);
	}

	// CMC range
	if (cmcMin) {
		conditions.push(`cards.cmc >= ?`);
		params.push(parseFloat(cmcMin));
	}
	if (cmcMax) {
		conditions.push(`cards.cmc <= ?`);
		params.push(parseFloat(cmcMax));
	}

	// Legality filter
	if (legality) {
		conditions.push(`json_extract(cards.legalities, ?) = 'legal'`);
		params.push(`$.${legality}`);
	}

	// Sort
	const validSorts: Record<string, string> = {
		name: 'cards.name',
		// Foil-only printings have no price_eur; sort them by their foil price
		// instead of pushing them to the end with the priceless cards. A user who
		// chose US dollars in /settings sorts by the TCGplayer price.
		price: locals.user?.currency === 'USD'
			? 'COALESCE(cards.price_usd, cards.price_usd_foil)'
			: 'COALESCE(cards.price_eur, cards.price_eur_foil)',
		cmc: 'cards.cmc',
		rarity: "CASE cards.rarity WHEN 'mythic' THEN 4 WHEN 'rare' THEN 3 WHEN 'uncommon' THEN 2 ELSE 1 END",
		set: 'cards.set_name',
		released: 'cards.released_at',
		power: 'CAST(cards.power AS REAL)',
		toughness: 'CAST(cards.toughness AS REAL)'
	};
	const orderColumn = validSorts[sortBy] || 'cards.name';
	const orderDir = sortDir === 'desc' ? 'DESC' : 'ASC';
	const nullHandling = ['price', 'power', 'toughness'].includes(sortBy) ? `NULLS LAST` : '';

	const { total: totalCards, rows: results } = queryCatalogue(sqlite, {
		conditions, params, printingConditions: Boolean(setCode || rarity), printings, orderBy: `${orderColumn} ${orderDir} ${nullHandling}`, limit: pageSize, offset
	});
	const totalPages = Math.max(1, Math.ceil(totalCards / pageSize));
	if (page > totalPages) error(404, 'Page not found');

	// Get all unique sets for the filter dropdown (cached, changes only on import)
	const sets = setsCache.get();

	// Collection and wishlist marks for the current page
	const userId = locals?.user?.id;
	const marks = userId ? userMarks(sqlite, userId, results, printings) : null;
	const collectedCardIds = marks?.collected ?? new Set<string>();
	const wishlistCardIds = marks?.wishlist ?? new Set<string>();

	// A card tile opens the card page (all printings); a printing tile its printing page.
	if (!printings) {
		const slugs = cardSlugIndex(sqlite).byOracle;
		for (const r of results) {
			r.slug = r.oracle_id && r.layout !== 'art_series' ? slugs.get(r.oracle_id as string) ?? null : null;
		}
	}

	return {
		cards: results,
		collectedCardIds: [...collectedCardIds],
		wishlistCardIds: [...wishlistCardIds],
		totalCards,
		page,
		pageSize,
		totalPages,
		filters: { query, colors, colorMode, type, setCode, rarity, cmcMin, cmcMax, legality, sortBy, sortDir, printings, pageSize },
		sets
	};
}
