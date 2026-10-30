import { parseUiScale, UI_SCALE_COOKIE } from '$lib/ui-scale';
import { DEFAULT_CURRENCY } from '$lib/currency';

export async function load({ locals, cookies }) {
	return {
		user: locals.user,
		// The display size of this browser (src/lib/ui-scale.ts), for the /settings panel.
		uiScale: parseUiScale(cookies.get(UI_SCALE_COOKIE)),
		// The display currency every page prices in (/settings); visitors see euros.
		currency: locals.user?.currency ?? DEFAULT_CURRENCY
	};
}
