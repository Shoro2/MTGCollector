/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />
/**
 * Offline mode of the card scanner (CLAUDE.md §6.5).
 *
 * Not registered automatically (`serviceWorker.register: false` in
 * svelte.config.js): only a visitor who presses "Make available offline" on
 * /scan installs it (src/lib/offline/client.ts), and "Turn off" removes it with
 * every cache it made. Which requests it handles is decided by
 * src/lib/offline/routes.ts; in short, the scanner page, the build's chunks
 * and the live detector work without a connection, everything else passes.
 *
 * Network first everywhere except the content-hashed chunks: online, the site
 * behaves as without the worker (the browser's HTTP cache still applies), and
 * the cached copies are only the fallback when the network fails or a
 * navigation's response does not start within NAVIGATION_TIMEOUT_MS.
 */
import { build, files, version } from '$service-worker';
import {
	appCacheName,
	cacheable,
	libraryCache,
	OFFLINE_CACHE_PREFIX,
	OFFLINE_PAGE,
	offlineRoute,
	PAGES_CACHE,
	precacheList,
	SCANNER_PAGE,
	scannerPageKey
} from '$lib/offline/routes';

const sw = self as unknown as ServiceWorkerGlobalScope;
const APP_CACHE = appCacheName(version);
/** A page whose response headers do not arrive within this time is served from the cache (a connection that is up but carries nothing). */
const NAVIGATION_TIMEOUT_MS = 6000;

sw.addEventListener('install', (event) => {
	event.waitUntil((async () => {
		const cache = await caches.open(APP_CACHE);
		await cache.addAll(precacheList(build, files, version));
		// The scanner page itself, as this browser's user sees it. /scan also has a
		// POST endpoint (+server.ts): without Accept: text/html SvelteKit answers 405. Best effort: the
		// page that turned offline mode on is about to store it again anyway.
		try {
			const res = await fetch(SCANNER_PAGE, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'text/html' } });
			if (cacheable(res)) await (await caches.open(PAGES_CACHE)).put(scannerPageKey(res.url), res);
		} catch {
			/* offline during install: the next online visit stores it */
		}
		await sw.skipWaiting();
	})());
});

sw.addEventListener('activate', (event) => {
	event.waitUntil((async () => {
		// Chunks of older builds go; the page and library caches stay.
		for (const key of await caches.keys()) {
			if (key.startsWith(`${OFFLINE_CACHE_PREFIX}app-`) && key !== APP_CACHE) await caches.delete(key);
		}
		await sw.clients.claim();
	})());
});

/** Store a copy of a response without delaying it; `event.waitUntil` keeps the worker alive until it is written. */
function keep(event: FetchEvent, cacheName: string, key: Request | string, res: Response): void {
	if (!cacheable(res)) return;
	const copy = res.clone();
	const write = caches.open(cacheName).then((c) => c.put(key, copy)).catch(() => { /* quota: the copy is optional */ });
	try {
		event.waitUntil(write);
	} catch {
		/* a slow response that arrived after the cached copy answered: the event is over, the write still runs */
	}
}

/** Network first with a cache fallback; `timeoutMs` serves the cache early when the response does not start in time. */
async function networkFirst(event: FetchEvent, cacheName: string, key: Request | string, timeoutMs = 0): Promise<Response> {
	const request = event.request;
	const network = fetch(request).then((res) => {
		keep(event, cacheName, key, res);
		return res;
	});
	try {
		if (timeoutMs <= 0) return await network;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
		const first = await Promise.race([network, timeout]);
		clearTimeout(timer);
		if (first !== 'timeout') return first;
		const cached = await caches.match(key, { cacheName, ignoreVary: true });
		if (cached) {
			network.catch(() => { /* it was slow; it may still fail */ });
			return cached;
		}
		return await network;
	} catch (err) {
		const cached = await caches.match(key, { cacheName, ignoreVary: true });
		if (cached) return cached;
		throw err;
	}
}

async function offlinePage(): Promise<Response> {
	return (await caches.match(OFFLINE_PAGE, { cacheName: APP_CACHE, ignoreVary: true })) ?? new Response('You are offline.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

sw.addEventListener('fetch', (event) => {
	const request = event.request;
	const route = offlineRoute({ url: request.url, method: request.method, mode: request.mode }, sw.location.origin);
	switch (route) {
		case 'pass':
			return;
		case 'immutable':
			event.respondWith((async () => {
				const cached = await caches.match(request, { ignoreSearch: true, ignoreVary: true });
				if (cached) return cached;
				const res = await fetch(request);
				keep(event, APP_CACHE, request, res);
				return res;
			})());
			return;
		case 'scanner-page': {
			const key = scannerPageKey(request.url);
			event.respondWith(networkFirst(event, PAGES_CACHE, key, request.mode === 'navigate' ? NAVIGATION_TIMEOUT_MS : 0).catch(async (err) => {
				if (request.mode === 'navigate') return offlinePage();
				throw err;
			}));
			return;
		}
		case 'asset':
			// The detection worker is requested with ?v=<version>; that exact URL is the key.
			event.respondWith(networkFirst(event, APP_CACHE, request));
			return;
		case 'library':
			event.respondWith(networkFirst(event, libraryCache(request.url, sw.location.origin, request.mode), request));
			return;
		case 'logout':
			event.respondWith((async () => {
				await caches.delete(PAGES_CACHE);
				return fetch(request);
			})());
			return;
		case 'navigation':
			event.respondWith(fetch(request).catch(() => offlinePage()));
			return;
	}
});
