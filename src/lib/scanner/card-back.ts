/**
 * The back of a Magic card. Every card shares it, so a scan whose artwork is
 * the card back says nothing about which card it is, and a reference hash of
 * the card back names arbitrary cards: Scryfall shows the ordinary card back
 * as the back face of the Mystery Booster 2 playtest cards (printed
 * single-sided), so `card_faces` holds this hash for Plant a Sapling // Fully-
 * Grown Treefolk (mb2 #582) and Liliana's Other Contract (mb2 #548). On the
 * owner's photo of eight card backs (2026-10-29, full catalogue) three of them
 * matched those faces at 4–8 bits and became one-tap offers; with only one of
 * the two records in the catalogue the 4- and 6-bit backs would have been
 * confirmed. The nearest front art measured 12 bits from this hash.
 */
import { hammingDistance } from './phash.js';

/** Art hash of the card back (the reference box of `ART_BOX`), from the mb2 back faces. */
export const CARD_BACK_HASH = '000b0f9f9d6d647c';
/** A scan this close (bits, upright or rotated) shows a card back: the backs on the owner's photo measured 4–8, the nearest front 12. */
export const CARD_BACK_SCAN = 10;
/** Reference hashes this close are the card back itself and stay out of the art index. */
export const CARD_BACK_REFERENCE = 4;

const HEX = /^[0-9a-f]{16}$/;

/** Distance of the nearer of the two hashes to the card back; null without a hash. */
export function cardBackDistance(hash?: string, alt?: string): number | null {
	let best: number | null = null;
	for (const h of [hash, alt]) {
		if (typeof h !== 'string' || !HEX.test(h)) continue;
		const d = hammingDistance(h, CARD_BACK_HASH);
		if (best === null || d < best) best = d;
	}
	return best;
}

/** Whether a reference hash is the card back (a face Scryfall shows as the plain back). */
export function isCardBackReference(hash: string): boolean {
	return HEX.test(hash) && hammingDistance(hash, CARD_BACK_HASH) <= CARD_BACK_REFERENCE;
}
