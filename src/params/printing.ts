import type { ParamMatcher } from '@sveltejs/kit';
import { isPrintingId } from '$lib/card-slug';

/** /cards/<Scryfall id> is a printing page; any other segment is a card slug. */
export const match: ParamMatcher = (param) => isPrintingId(param);
