/**
 * Turning the scanner's offline mode on and off from the page (CLAUDE.md §6.5).
 *
 * On: register src/service-worker.ts, wait until it controls the page, then
 * request the files the offline scanner needs once more so they pass through
 * the worker and land in its caches (the page has often loaded OpenCV.js
 * before, and a script already in memory is not requested again).
 * Off: unregister the worker and delete every cache it made. The queue of
 * saved captures (queue.ts) is separate; the page asks before clearing it.
 */
import { OFFLINE_CACHE_PREFIX, SCANNER_PAGE } from './routes';

const SW_URL = '/service-worker.js';
const CONTROL_TIMEOUT_MS = 15_000;
const STORE_TIMEOUT_MS = 10_000;

/** Whether this browser can keep the scanner offline (service workers need a secure context). */
export function offlineSupported(): boolean {
	return typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator && 'caches' in window;
}

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
	if (!offlineSupported()) return undefined;
	const reg = await navigator.serviceWorker.getRegistration('/');
	return reg && [reg.active, reg.waiting, reg.installing].some((w) => w?.scriptURL.endsWith(SW_URL)) ? reg : undefined;
}

/** Whether offline mode is on; also asks the browser to look for a newer worker (a deploy). */
export async function offlineEnabled(): Promise<boolean> {
	try {
		const reg = await registration();
		if (!reg) return false;
		reg.update().catch(() => { /* offline: the next visit checks */ });
		return true;
	} catch {
		return false;
	}
}

/** The scanner page and the warm URLs not (yet) in the worker's caches. */
async function missingCopies(warmUrls: string[]): Promise<string[]> {
	const own = location.origin;
	const missing: string[] = [];
	for (const url of [SCANNER_PAGE, ...warmUrls]) {
		if (!(await caches.match(new URL(url, own).href, { ignoreVary: true }))) missing.push(url);
	}
	return missing;
}

export type OfflineState = 'off' | 'ready' | 'incomplete';

/**
 * 'ready' only when the worker is registered and every file the offline
 * scanner needs is stored; 'incomplete' when the worker is there but a file is
 * missing (a turn-on that failed before 2026-10-29 left the worker behind, or
 * the browser evicted a cache).
 */
export async function offlineState(warmUrls: string[]): Promise<OfflineState> {
	if (!(await offlineEnabled())) return 'off';
	try {
		return (await missingCopies(warmUrls)).length === 0 ? 'ready' : 'incomplete';
	} catch {
		return 'incomplete';
	}
}

function waitForControl(): Promise<void> {
	if (navigator.serviceWorker.controller) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('The offline helper did not start. Reload the page and try again.')), CONTROL_TIMEOUT_MS);
		navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timer); resolve(); }, { once: true });
	});
}

/**
 * Turn offline mode on. `warmUrls` are the scanner files to store beyond the
 * build (the OpenCV.js URL, the detection worker with its version query).
 * `dev` registers the worker as a module, as Vite serves it in development.
 * A failure turns offline mode off again, so the page never reports "ready"
 * with the card detector missing.
 */
export async function enableOffline(warmUrls: string[], dev = false): Promise<void> {
	if (!offlineSupported()) throw new Error('This browser cannot keep pages offline.');
	try {
		await storeScanner(warmUrls, dev);
	} catch (err) {
		try { await disableOffline(); } catch { /* the original error matters more */ }
		throw err;
	}
	// Ask the browser not to evict the stored scanner under storage pressure (it may say no).
	try { await navigator.storage?.persist?.(); } catch { /* optional */ }
}

/** Where a file comes from, for error messages: "/scan", "docs.opencv.org/4.9.0/opencv.js". */
function label(url: string): string {
	const u = new URL(url, location.origin);
	return u.origin === location.origin ? u.pathname : `${u.host}${u.pathname}`;
}

async function storeScanner(warmUrls: string[], dev: boolean): Promise<void> {
	await navigator.serviceWorker.register(SW_URL, { scope: '/', type: dev ? 'module' : 'classic' });
	await navigator.serviceWorker.ready;
	await waitForControl();
	const own = location.origin;
	for (const url of [SCANNER_PAGE, ...warmUrls]) {
		const sameOrigin = new URL(url, own).origin === own;
		// A script tag requests OpenCV without CORS; store it the same way so it answers that request.
		// /scan also has a POST endpoint; only Accept: text/html gets the page.
		const init: RequestInit = !sameOrigin ? { mode: 'no-cors', credentials: 'omit' }
			: url === SCANNER_PAGE ? { credentials: 'same-origin', headers: { Accept: 'text/html' } }
			: { credentials: 'same-origin' };
		let res: Response;
		try {
			res = await fetch(url, init);
		} catch (err) {
			// Browsers say only "NetworkError when attempting to fetch resource." / "Failed to fetch"; name the file.
			throw new Error(`Could not download ${label(url)} (${(err as Error).message || 'network error'}).`);
		}
		if (sameOrigin && !res.ok) throw new Error(`Could not store ${label(url)} (${res.status}).`);
		await res.arrayBuffer(); // the worker stores a copy; reading ours completes the download
	}
	// The worker writes its copies in the background; report "ready" only once they are there.
	const deadline = Date.now() + STORE_TIMEOUT_MS;
	for (;;) {
		const missing = await missingCopies(warmUrls);
		if (missing.length === 0) return;
		if (Date.now() > deadline) throw new Error(`${label(missing[0])} could not be stored (is the storage full?).`);
		await new Promise((r) => setTimeout(r, 100));
	}
}

/** Turn offline mode off: unregister the worker and delete its caches. */
export async function disableOffline(): Promise<void> {
	const reg = await registration();
	if (reg) await reg.unregister();
	if (typeof caches !== 'undefined') {
		for (const key of await caches.keys()) if (key.startsWith(OFFLINE_CACHE_PREFIX)) await caches.delete(key);
	}
}

/** Bytes this site stores in the browser (caches and the saved captures), when the browser says. */
export async function storedBytes(): Promise<number | null> {
	try {
		const estimate = await navigator.storage?.estimate?.();
		return typeof estimate?.usage === 'number' ? estimate.usage : null;
	} catch {
		return null;
	}
}

/** "14.8 MB" */
export function formatBytes(bytes: number): string {
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
