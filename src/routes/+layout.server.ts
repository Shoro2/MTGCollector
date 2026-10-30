import { parseUiScale, UI_SCALE_COOKIE } from '$lib/ui-scale';

export async function load({ locals, cookies }) {
	return {
		user: locals.user,
		// The display size of this browser (src/lib/ui-scale.ts), for the /settings panel.
		uiScale: parseUiScale(cookies.get(UI_SCALE_COOKIE))
	};
}
