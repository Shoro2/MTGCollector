import { describe, expect, it } from 'vitest';
import { parseUiScale, rootFontScale, uiScaleCookie, UI_SCALE_COOKIE, UI_SCALE_MAX_AGE } from './ui-scale';

describe('UI scale', () => {
	it('accepts the offered sizes and falls back to automatic', () => {
		expect(parseUiScale('125')).toBe('125');
		expect(parseUiScale('90')).toBe('90');
		expect(parseUiScale('auto')).toBe('auto');
		expect(parseUiScale(undefined)).toBe('auto');
		expect(parseUiScale('')).toBe('auto');
		expect(parseUiScale('300')).toBe('auto');
		expect(parseUiScale('"><script>')).toBe('auto');
	});

	it('stores a size for a year and deletes the cookie for automatic', () => {
		expect(uiScaleCookie('125', true)).toBe(`${UI_SCALE_COOKIE}=125; Path=/; SameSite=Lax; Secure; Max-Age=${UI_SCALE_MAX_AGE}`);
		expect(uiScaleCookie('110', false)).toBe(`${UI_SCALE_COOKIE}=110; Path=/; SameSite=Lax; Max-Age=${UI_SCALE_MAX_AGE}`);
		expect(uiScaleCookie('auto', true)).toBe(`${UI_SCALE_COOKIE}=; Path=/; SameSite=Lax; Secure; Max-Age=0`);
	});

	it('reads 1 without a document (server, tests)', () => {
		expect(rootFontScale()).toBe(1);
	});
});
