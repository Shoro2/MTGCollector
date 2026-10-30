// UI size ("Display size" in /settings). The whole interface is sized in rem, so
// one root font size scales text, spacing, images and the page width together.
//
// The choice belongs to the browser, not to the account: a large desktop monitor
// and a phone need different sizes. It lives in a cookie so the server renders
// <html data-ui-scale="…"> (src/hooks.server.ts) and the first paint already has
// the right size. The CSS for every value is in src/app.css.
//
// 'auto' (the default, also for a missing or unknown cookie) keeps 100 % up to a
// 1920 px wide window and grows slowly above it (about 120 % at 2560 px). The
// fixed sizes above 100 % apply from 640 px up; phones keep the normal size so
// every page still fits 320 px without sideways scrolling.

export const UI_SCALE_COOKIE = 'mtg_ui_scale';

export const UI_SCALES = ['auto', '90', '100', '110', '125', '150'] as const;

export type UiScale = (typeof UI_SCALES)[number];

export const UI_SCALE_LABELS: Record<UiScale, string> = {
	auto: 'Automatic',
	'90': '90 %',
	'100': '100 %',
	'110': '110 %',
	'125': '125 %',
	'150': '150 %'
};

/** One year, renewed whenever the size is chosen again. */
export const UI_SCALE_MAX_AGE = 60 * 60 * 24 * 365;

export function parseUiScale(value: string | null | undefined): UiScale {
	return (UI_SCALES as readonly string[]).includes(value ?? '') ? (value as UiScale) : 'auto';
}

/** The `document.cookie` assignment that stores a choice; 'auto' deletes the cookie. */
export function uiScaleCookie(scale: UiScale, secure: boolean): string {
	const flags = `; Path=/; SameSite=Lax${secure ? '; Secure' : ''}`;
	return scale === 'auto'
		? `${UI_SCALE_COOKIE}=${flags}; Max-Age=0`
		: `${UI_SCALE_COOKIE}=${scale}${flags}; Max-Age=${UI_SCALE_MAX_AGE}`;
}

/**
 * The root font size relative to the browser's 16 px default (1.25 at 125 %).
 * Chart.js draws its labels in pixels and multiplies its 12 px default with it.
 */
export function rootFontScale(): number {
	if (typeof document === 'undefined') return 1;
	const size = parseFloat(getComputedStyle(document.documentElement).fontSize);
	return Number.isFinite(size) && size > 0 ? size / 16 : 1;
}
