import { error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { deckCards, hasReported, ownedCards, ownedPrintings, readableDeck } from '$lib/server/decks';
import { getUsdToEurRate } from '$lib/server/exchange-rate';
import { allocateOwnership, cardFrame, deckColors, deckTotals, manaCurve, ownershipKey, unitPriceEur } from '$lib/deck';
import { canHavePartner, checkDeck } from '$lib/deck-formats';

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
		? allocateOwnership(
			rows.map((r) => ({ ...r, key: ownershipKey(r) })),
			ownedCards(sqlite, viewer, rows.map(ownershipKey)),
			ownedPrintings(sqlite, viewer, rows.map((r) => r.card_id))
		)
		: null;
	const check = checkDeck(rows, deck.format);
	const isOwner = viewer !== null && deck.user_id === viewer;
	// The owner may add a second commander when the only one can take a partner.
	const zone = rows.filter((r) => r.board === 'commander');
	const command = check.format.command;
	const partnerOf = isOwner && command && command !== 'oathbreaker' && zone.length === 1 && zone[0].quantity === 1 && canHavePartner(zone[0])
		? { cardId: zone[0].card_id, name: zone[0].name }
		: null;
	return {
		deck: {
			id: deck.id, name: deck.name, format: deck.format, visibility: deck.visibility, bracket: deck.bracket ?? null,
			// A deck hidden after reports keeps its description from everybody but its owner.
			description: deck.hidden_at && !isOwner ? '' : deck.description,
			hidden: !!deck.hidden_at,
			created_at: deck.created_at, updated_at: deck.updated_at
		},
		isOwner,
		partnerOf,
		reported: viewer !== null && !isOwner ? hasReported(sqlite, viewer, deck.id) : false,
		signedIn: viewer !== null,
		rows: rows.map(({ legalities: _l, oracle_text: _t, ...row }) => ({
			...row, unit: unitPriceEur(row, rate), owned: ownership?.get(row.id) ?? null, frame: cardFrame(row)
		})),
		check: { formatLabel: check.format.label, kind: check.format.kind, problems: check.problems, unchecked: check.unchecked },
		totals: deckTotals(rows, rate, ownership),
		curve: manaCurve(rows),
		colors: deckColors(rows)
	};
}
