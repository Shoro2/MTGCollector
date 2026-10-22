import { error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { deckCards, ownedCards, readableDeck } from '$lib/server/decks';
import { getUsdToEurRate } from '$lib/server/exchange-rate';
import { allocateOwnership, deckColors, deckTotals, manaCurve, ownershipKey, unitPriceEur } from '$lib/deck';
import { checkDeck } from '$lib/deck-formats';

/**
 * One deck, for its owner and for anyone with the link unless it is private. Ownership
 * marks compare the deck with the viewer's own collection; the owner's collection and
 * name never reach other viewers.
 */
export async function load({ params, locals, depends }) {
	depends('app:deck');
	const viewer = locals.user?.id ?? null;
	const deck = readableDeck(sqlite, params.id, viewer);
	if (!deck) throw error(404, 'Deck not found');
	const rows = deckCards(sqlite, deck.id);
	const rate = await getUsdToEurRate();
	const ownership = viewer
		? allocateOwnership(rows.map((r) => ({ ...r, key: ownershipKey(r) })), ownedCards(sqlite, viewer, rows.map(ownershipKey)))
		: null;
	const check = checkDeck(rows, deck.format);
	return {
		deck: { id: deck.id, name: deck.name, format: deck.format, visibility: deck.visibility, description: deck.description, created_at: deck.created_at, updated_at: deck.updated_at },
		isOwner: viewer !== null && deck.user_id === viewer,
		signedIn: viewer !== null,
		rows: rows.map(({ legalities: _l, oracle_text: _t, ...row }) => ({ ...row, unit: unitPriceEur(row, rate), owned: ownership?.get(row.id) ?? null })),
		check: { formatLabel: check.format.label, kind: check.format.kind, problems: check.problems, unchecked: check.unchecked },
		totals: deckTotals(rows, rate, ownership),
		curve: manaCurve(rows),
		colors: deckColors(rows)
	};
}
