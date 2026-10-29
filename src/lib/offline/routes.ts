/**
 * Which requests the offline service worker (src/service-worker.ts) handles,
 * and how. Pure, so the routing is unit-tested without a browser; the worker
 * itself only executes the strategy this module picks.
 *
 * The worker exists only after a user turned on offline mode on /scan, and it
 * deliberately handles very little: the scanner page, the build's immutable
 * chunks, the live detector (worker script + OpenCV.js) and a fallback page.
 * Everything else, every POST, every API call and every other page, passes
 * through untouched, so the rest of the site behaves exactly as without it.
 */

/** Static page shown when a navigation fails while offline. */
export const OFFLINE_PAGE = '/offline.html';
/** The page that works offline. */
export const SCANNER_PAGE = '/scan';
/** SvelteKit's data endpoint of the scanner page (client-side navigation). */
export const SCANNER_DATA = '/scan/__data.json';

/** Cross-origin hosts the scanner libraries come from by default (src/lib/scanner/assets.ts). */
export const LIBRARY_HOSTS = ['docs.opencv.org', 'cdn.jsdelivr.net'];

/** Cache names. Every cache the worker owns starts with OFFLINE_CACHE_PREFIX, so turning offline mode off can delete them all. */
export const OFFLINE_CACHE_PREFIX = 'mtg-offline-';
/** Immutable build chunks, the fallback page, icons and the detection worker of one build; replaced with every deploy. */
export const appCacheName = (version: string) => `${OFFLINE_CACHE_PREFIX}app-${version}`;
/** The scanner page as last loaded online (HTML and its __data.json). */
export const PAGES_CACHE = `${OFFLINE_CACHE_PREFIX}pages`;
/** OpenCV.js, cached as fetched. Separate caches for CORS and opaque (no-cors) responses, because an opaque response must never answer a CORS request. */
export const LIBS_CACHE = `${OFFLINE_CACHE_PREFIX}libs`;
export const LIBS_OPAQUE_CACHE = `${OFFLINE_CACHE_PREFIX}libs-opaque`;

export type OfflineRoute =
	/** /_app/immutable/*: content-hashed, so cache first is always correct. */
	| 'immutable'
	/** /scan and its __data.json: network first, the cached copy when offline. */
	| 'scanner-page'
	/** Own static files of this build the offline scanner needs (detection worker, fallback page, icons, manifest): network first, cache fallback. */
	| 'asset'
	/** OpenCV.js, self-hosted or from its CDN: network first, cache fallback, kept across deploys (it is versioned by its URL, not by the build). */
	| 'library'
	/** Sign-out (the POST form to /auth/logout) and account deletion: the cached scanner page holds the signed-in user's data, so it is dropped, then the request passes on. */
	| 'logout'
	/** Any other page navigation: network, the offline page when the network fails. */
	| 'navigation'
	/** Everything else: not touched. */
	| 'pass';

export type RouteRequest = { url: string; method: string; mode: RequestMode | string };

/** Own static files the offline scanner needs. */
function isOfflineAsset(pathname: string): boolean {
	return pathname === OFFLINE_PAGE
		|| pathname === '/favicon.ico'
		|| pathname === '/manifest.webmanifest'
		|| pathname.startsWith('/icons/')
		|| pathname.startsWith('/scanner/');
}

/** The strategy for one request; `origin` is the site's own origin. */
export function offlineRoute(req: RouteRequest, origin: string): OfflineRoute {
	let url: URL;
	try {
		url = new URL(req.url);
	} catch {
		return 'pass';
	}
	if (url.origin === origin && ((url.pathname === '/auth/logout' && req.mode === 'navigate') || (url.pathname === '/api/account' && req.method === 'DELETE'))) return 'logout';
	if (req.method !== 'GET') return 'pass';
	if (url.origin !== origin) {
		return LIBRARY_HOSTS.includes(url.hostname) && url.pathname.endsWith('/opencv.js') ? 'library' : 'pass';
	}
	const path = url.pathname;
	if (path.startsWith('/_app/immutable/')) return 'immutable';
	if (path === SCANNER_PAGE || path === `${SCANNER_PAGE}/` || path === SCANNER_DATA) return 'scanner-page';
	// `/vendor/` holds every self-hosted library (~75 MB); only OpenCV is needed offline.
	if (path.startsWith('/vendor/') && path.endsWith('/opencv.js')) return 'library';
	if (isOfflineAsset(path)) return 'asset';
	if (req.mode === 'navigate') return 'navigation';
	return 'pass';
}

/**
 * The key a scanner-page response is stored under: the path without its query,
 * so `/scan?x` and `/scan/__data.json?x-sveltekit-invalidated=…` find the copy.
 */
export function scannerPageKey(url: string): string {
	const u = new URL(url);
	const path = u.pathname === `${SCANNER_PAGE}/` ? SCANNER_PAGE : u.pathname;
	return `${u.origin}${path}`;
}

/** Whether a response may be stored: a complete success, or an opaque one (a no-cors script, whose status cannot be read). */
/**
 * The cache a library response belongs in. An opaque response (a cross-origin
 * script fetched without CORS) must never answer a CORS request, so those get
 * their own cache; same-origin responses are never opaque.
 */
export function libraryCache(url: string, origin: string, mode: RequestMode | string): string {
	return new URL(url).origin !== origin && mode === 'no-cors' ? LIBS_OPAQUE_CACHE : LIBS_CACHE;
}

export function cacheable(res: { ok: boolean; type: string; status: number; redirected?: boolean }): boolean {
	if (res.type === 'opaque') return true;
	return res.ok && res.status === 200 && !res.redirected;
}

/**
 * Files of a build that the worker stores at install: the immutable chunks
 * (every route's, so the cached scanner page can still load a lazy chunk), the
 * fallback page, the icons, the manifest and this build's detection worker
 * (the page requests it as `detect-worker.js?v=<version>`). `files` is the
 * whole static folder, which may hold the self-hosted libraries and local
 * card images; they are left out.
 */
export function precacheList(build: string[], files: string[], version: string): string[] {
	const wanted = files.filter((f) => f === OFFLINE_PAGE || f === '/favicon.ico' || f === '/manifest.webmanifest' || f.startsWith('/icons/'));
	const worker = files.includes('/scanner/detect-worker.js') ? [`/scanner/detect-worker.js?v=${encodeURIComponent(version)}`] : [];
	return [...new Set([...build, ...wanted, ...worker])];
}
