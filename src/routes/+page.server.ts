import { db } from '$lib/server/db';
import { cards, collectionCards } from '$lib/server/schema';
import { sql, eq, and } from 'drizzle-orm';

export async function load({ locals }) {
	const totalCardsResult = db.select({ count: sql<number>`count(*)` }).from(cards).get();

	const userId = locals.user?.id;

	if (!userId) {
		return {
			totalCards: totalCardsResult?.count ?? 0,
			collectionCount: 0,
			collectionValue: 0
		};
	}

	const collectionResult = db
		.select({
			count: sql<number>`count(*)`,
			totalQty: sql<number>`COALESCE(sum(${collectionCards.quantity}), 0)`
		})
		.from(collectionCards)
		.where(eq(collectionCards.userId, userId))
		.get();

	const valueResult = db
		.select({
			total: sql<number>`COALESCE(sum(
				CASE WHEN ${collectionCards.foil} = 1 THEN ${cards.priceEurFoil} ELSE ${cards.priceEur} END
				* ${collectionCards.quantity}
			), 0)`
		})
		.from(collectionCards)
		.innerJoin(cards, sql`${collectionCards.cardId} = ${cards.id}`)
		// Proxies count as cards above, never as value.
		.where(and(eq(collectionCards.userId, userId), eq(collectionCards.proxy, false)))
		.get();

	return {
		totalCards: totalCardsResult?.count ?? 0,
		collectionCount: collectionResult?.totalQty ?? 0,
		collectionValue: valueResult?.total ?? 0
	};
}
