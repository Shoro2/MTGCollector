import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCardImageCache } from './card-image-cache';
import { parseScryfallImage } from '../card-image';

const ID = '7a79190f-de60-4eb6-b925-594eb76ca8c3';
const image = (version = '1783903901') =>
	parseScryfallImage(`https://cards.scryfall.io/normal/front/7/a/${ID}.jpg?${version}`)!;

const dirs: string[] = [];
function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), 'card-images-'));
	dirs.push(dir);
	return dir;
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function fakeScryfall(answer: () => Response | Promise<Response>) {
	const calls: string[] = [];
	const fetch = (async (input: RequestInfo | URL) => {
		calls.push(String(input));
		return answer();
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

const jpeg = (bytes = 'JPEGDATA') => new Response(bytes, { headers: { 'content-type': 'image/jpeg' } });

describe('card image cache', () => {
	it('fetches a miss once from Scryfall at the asked size, stores it and serves it from disk', async () => {
		const scryfall = fakeScryfall(() => jpeg());
		const cache = createCardImageCache({ dir: tempDir(), fetch: scryfall.fetch });
		const first = await cache.get(image(), 'small');
		expect(first).toMatchObject({ ok: true, cached: false });
		expect(scryfall.calls).toEqual([`https://cards.scryfall.io/small/front/7/a/${ID}.jpg?1783903901`]);
		expect(existsSync(cache.pathFor(image(), 'small'))).toBe(true);
		const second = await cache.get(image(), 'small');
		expect(second).toMatchObject({ ok: true, cached: true });
		expect(second.ok && second.body.toString()).toBe('JPEGDATA');
		expect(scryfall.calls).toHaveLength(1);
	});

	it('shares one fetch between concurrent requests', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const scryfall = fakeScryfall(async () => {
			await gate;
			return jpeg();
		});
		const cache = createCardImageCache({ dir: tempDir(), fetch: scryfall.fetch });
		const all = Promise.all([cache.get(image(), 'normal'), cache.get(image(), 'normal'), cache.get(image(), 'normal')]);
		release();
		expect((await all).every((r) => r.ok)).toBe(true);
		expect(scryfall.calls).toHaveLength(1);
	});

	it('answers 502 when Scryfall refuses and does not ask again during the backoff', async () => {
		let t = 0;
		const scryfall = fakeScryfall(() => new Response('blocked', { status: 403, headers: { 'content-type': 'text/html' } }));
		const cache = createCardImageCache({ dir: tempDir(), fetch: scryfall.fetch, now: () => t, failureBackoffMs: 1000 });
		expect(await cache.get(image(), 'normal')).toEqual({ ok: false, status: 502 });
		expect(await cache.get(image(), 'normal')).toEqual({ ok: false, status: 502 });
		expect(scryfall.calls).toHaveLength(1);
		t = 1001;
		await cache.get(image(), 'normal');
		expect(scryfall.calls).toHaveLength(2);
	});

	it('refuses answers that are not images, empty or too large, and network errors', async () => {
		for (const answer of [
			() => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
			() => jpeg(''),
			() => jpeg('x'.repeat(20)),
			() => Promise.reject(new TypeError('fetch failed'))
		]) {
			const cache = createCardImageCache({ dir: tempDir(), fetch: fakeScryfall(answer).fetch, maxBytes: 10 });
			expect(await cache.get(image(), 'normal')).toEqual({ ok: false, status: 502 });
		}
	});

	it('passes a 404 on', async () => {
		const cache = createCardImageCache({ dir: tempDir(), fetch: fakeScryfall(() => new Response('', { status: 404 })).fetch });
		expect(await cache.get(image(), 'normal')).toEqual({ ok: false, status: 404 });
	});

	it('replaces the file of an older image version', async () => {
		const cache = createCardImageCache({ dir: tempDir(), fetch: fakeScryfall(() => jpeg()).fetch });
		await cache.get(image('1774980244'), 'normal');
		await cache.get(image('1783903901'), 'normal');
		expect(readdirSync(dirname(cache.pathFor(image(), 'normal')))).toEqual([`${ID}.1783903901.jpg`]);
	});

	it('limits upstream fetches per minute', async () => {
		let t = 0;
		const scryfall = fakeScryfall(() => jpeg());
		const cache = createCardImageCache({ dir: tempDir(), fetch: scryfall.fetch, perMinute: 2, now: () => t });
		const other = (v: string) => image(v);
		expect((await cache.get(other('1'), 'normal')).ok).toBe(true);
		expect((await cache.get(other('2'), 'normal')).ok).toBe(true);
		expect(await cache.get(other('3'), 'normal')).toEqual({ ok: false, status: 503 });
		t = 60_000;
		expect((await cache.get(other('3'), 'normal')).ok).toBe(true);
	});
});
