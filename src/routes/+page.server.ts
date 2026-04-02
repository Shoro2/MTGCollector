import { db } from '$lib/server/db';
import { cards, collectionCards } from '$lib/server/schema';
import { sql } from 'drizzle-orm';

export async function load() {
	const totalCardsResult = db.select({ count: sql<number>`count(*)` }).from(cards).get();
	const collectionResult = db
		.select({
			count: sql<number>`count(*)`,
			totalQty: sql<number>`COALESCE(sum(${collectionCards.quantity}), 0)`
		})
		.from(collectionCards)
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
		.get();

	return {
		totalCards: totalCardsResult?.count ?? 0,
		collectionCount: collectionResult?.totalQty ?? 0,
		collectionValue: valueResult?.total ?? 0
	};
}
