import { describe, expect, it } from 'vitest';
import { isDecodablePath } from './request-path';

// SvelteKit's decode_pathname() (src/utils/url.js), copied so the test pins the equivalence.
const svelteKitDecodes = (pathname: string) => {
	try {
		pathname.split('%25').map(decodeURI).join('%25');
		return true;
	} catch {
		return false;
	}
};

const decodable = [
	'/',
	'/cards/teferis-protection',
	'/cards/teferi%27s-protection',
	'/cards/j%C3%B6tun-grunt',
	'/decks/a%2Fb',
	'/%25c0',
	'/%25'
];

const malformed = [
	'/%c0',
	'/%c0%ae%c0%ae/etc/passwd',
	'/%E0%A4%A',
	'/%ED%A0%80',
	'/%',
	'/%zz',
	'/%2%255',
	'/%%2541',
	'/api/%c0',
	'/admin%c0',
	'/collection/scan%c0'
];

describe('isDecodablePath', () => {
	it('accepts plain paths and valid percent-encoding', () => {
		for (const path of decodable) expect(isDecodablePath(path), path).toBe(true);
	});

	it('rejects malformed percent-encoding', () => {
		for (const path of malformed) expect(isDecodablePath(path), path).toBe(false);
	});

	it('agrees with the decoding SvelteKit does before routing', () => {
		for (const path of [...decodable, ...malformed]) {
			expect(isDecodablePath(path), path).toBe(svelteKitDecodes(path));
		}
	});
});
