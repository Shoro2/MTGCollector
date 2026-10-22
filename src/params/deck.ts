import type { ParamMatcher } from '@sveltejs/kit';
import { isDeckId } from '$lib/deck';

/** /decks/<id>: random 16-character deck ids only, so fixed routes beside it stay free. */
export const match: ParamMatcher = (param) => isDeckId(param);
