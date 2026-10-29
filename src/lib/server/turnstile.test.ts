import { describe, expect, it } from 'vitest';
import { SITEVERIFY_URL, turnstileConfig, verifyTurnstile } from './turnstile';

const config = { siteKey: 'site', secret: 'secret', verifyUrl: SITEVERIFY_URL };

/** A stand-in for Cloudflare's siteverify that records what it was sent. */
function fakeFetch(answer: unknown, calls: { url: string; body: URLSearchParams }[] = []) {
	return (async (url: string, init: RequestInit) => {
		calls.push({ url, body: init.body as URLSearchParams });
		if (answer instanceof Error) throw answer;
		return new Response(JSON.stringify(answer));
	}) as unknown as typeof fetch;
}

describe('turnstileConfig', () => {
	it('is on only with both keys', () => {
		expect(turnstileConfig({})).toBeNull();
		expect(turnstileConfig({ PUBLIC_TURNSTILE_SITE_KEY: 'site' })).toBeNull();
		expect(turnstileConfig({ TURNSTILE_SECRET_KEY: 'secret', PUBLIC_TURNSTILE_SITE_KEY: '  ' })).toBeNull();
		expect(turnstileConfig({ PUBLIC_TURNSTILE_SITE_KEY: ' site ', TURNSTILE_SECRET_KEY: 'secret' })).toEqual(config);
		expect(turnstileConfig({ PUBLIC_TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret', TURNSTILE_VERIFY_URL: 'http://127.0.0.1:9/verify' })?.verifyUrl)
			.toBe('http://127.0.0.1:9/verify');
	});
});

describe('verifyTurnstile', () => {
	it('passes everything when the captcha is off', async () => {
		expect(await verifyTurnstile(null, undefined, null)).toBe(true);
	});

	it('refuses a missing or oversized token without asking Cloudflare', async () => {
		const calls: { url: string; body: URLSearchParams }[] = [];
		for (const token of [undefined, '', 5, 'x'.repeat(2049)]) expect(await verifyTurnstile(config, token, null, undefined, fakeFetch({ success: true }, calls))).toBe(false);
		expect(calls).toEqual([]);
	});

	it('sends secret, token and address, and checks the answer and the action', async () => {
		const calls: { url: string; body: URLSearchParams }[] = [];
		expect(await verifyTurnstile(config, 'token', '203.0.113.7', 'publish-deck', fakeFetch({ success: true, action: 'publish-deck' }, calls))).toBe(true);
		expect(calls[0].url).toBe(SITEVERIFY_URL);
		expect(Object.fromEntries(calls[0].body)).toEqual({ secret: 'secret', response: 'token', remoteip: '203.0.113.7' });
		expect(await verifyTurnstile(config, 'token', null, 'publish-deck', fakeFetch({ success: true, action: 'contact' }))).toBe(false);
		expect(await verifyTurnstile(config, 'token', null, undefined, fakeFetch({ success: true, action: 'contact' }))).toBe(true);
		expect(await verifyTurnstile(config, 'token', null, undefined, fakeFetch({ success: false, 'error-codes': ['timeout-or-duplicate'] }))).toBe(false);
	});

	it('counts a network error or a broken answer as a failed check', async () => {
		expect(await verifyTurnstile(config, 'token', null, undefined, fakeFetch(new Error('offline')))).toBe(false);
		const broken = (async () => new Response('<html>')) as unknown as typeof fetch;
		expect(await verifyTurnstile(config, 'token', null, undefined, broken)).toBe(false);
	});
});
