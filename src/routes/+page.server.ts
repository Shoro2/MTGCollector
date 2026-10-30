import { sqlite } from '$lib/server/db';
import { cardSlugIndex } from '$lib/server/card-slugs';
import { homeCatalogueCache, priceDataCache } from '$lib/server/cache';
import { recentlyAdded, setCodes, wishlistCount } from '$lib/server/home-data';
import { chartPaths, collectionMoves, dashboardSummary, movesHeading, type Mover } from '$lib/home';

export async function load({ locals }) {
	const slugs = cardSlugIndex(sqlite);
	const cardCount = slugs.slugs.length;
	const catalogueEmpty = !sqlite.prepare('SELECT 1 FROM cards LIMIT 1').get();
	const userId = locals.user?.id;

	if (!userId) {
		const home = await homeCatalogueCache.get('catalogue');
		const withLink = (m: Mover) => ({ ...m, href: slugs.byOracle.has(m.oracleId) ? `/cards/${slugs.byOracle.get(m.oracleId)}` : null });
		return {
			cardCount,
			catalogueEmpty,
			visitor: {
				movesHeading: home.date ? movesHeading(home.date, home.previousDate) : null,
				up: home.moves.up.map(withLink),
				down: home.moves.down.map(withLink),
				sample: home.sample
			},
			dashboard: null
		};
	}

	const data = await priceDataCache.get(userId);
	const today = new Date().toISOString().slice(0, 10);
	const moves = collectionMoves(data.topCards);
	const codes = setCodes(sqlite, [...moves.up, ...moves.down].map(m => m.id));
	const withSet = <T extends { id: string }>(m: T) => ({ ...m, setCode: (codes.get(m.id) ?? '').toUpperCase() });
	return {
		cardCount,
		catalogueEmpty,
		visitor: null,
		dashboard: {
			// Every amount of the dashboard is in the user's display currency (getPriceData()).
			currency: data.currency,
			summary: dashboardSummary(data),
			profitCopies: data.stats.profitCopies,
			wishlist: wishlistCount(sqlite, userId),
			chart: chartPaths(data.profitHistory, { today }),
			up: moves.up.map(withSet),
			down: moves.down.map(withSet),
			recent: recentlyAdded(sqlite, userId)
		}
	};
}
