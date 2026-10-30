import { DEFAULT_CURRENCY } from '$lib/currency';

export async function load({ locals }) {
	return {
		user: locals.user,
		// The display currency every page prices in (/settings); visitors see euros.
		currency: locals.user?.currency ?? DEFAULT_CURRENCY
	};
}
