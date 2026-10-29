import { sqlite, initDb } from '$lib/server/db';
import {
	checkAndUpdatePrices,
	isMissingTodaySnapshot,
	isMissingYesterdaySnapshot
} from '$lib/server/price-updater';
import { validateSession } from '$lib/server/auth';
import { isDecodablePath } from '$lib/server/request-path';
import { CSP } from '$lib/server/csp';
import { error, redirect, text, type Handle } from '@sveltejs/kit';
import { dev } from '$app/environment';

initDb();

const PRICE_UPDATE_HOUR = 18;
const WATCHDOG_INTERVAL_MS = 60 * 60 * 1000;

function scheduleDailyPriceUpdate() {
	// Re-arm against the wall clock after every run instead of chaining a fixed
	// 24h setInterval: the interval drifts away from the 18:00 slot and, more
	// importantly, a single missed tick used to mean no further updates at all.
	const armNextSlot = () => {
		const now = new Date();
		const next = new Date(now);
		next.setHours(PRICE_UPDATE_HOUR, 0, 0, 0);
		if (now >= next) {
			next.setDate(next.getDate() + 1);
		}
		const msUntilNext = next.getTime() - now.getTime();
		console.log(`[price-updater] Next price update scheduled at ${next.toISOString()} (in ${Math.round(msUntilNext / 1000 / 60)} minutes)`);
		setTimeout(() => {
			checkAndUpdatePrices();
			armNextSlot();
		}, msUntilNext);
	};
	armNextSlot();

	// Hourly watchdog. The daily timer, the update lock and the retry chain are
	// all in-process state, so any one of them can be lost while the process
	// keeps serving traffic — which is how price_history ended up with
	// multi-week gaps that only a restart cleared. This check is the backstop:
	// once the 18:00 slot has passed and today still has no snapshot, run.
	setInterval(() => {
		try {
			if (new Date().getHours() < PRICE_UPDATE_HOUR) return;
			if (!isMissingTodaySnapshot()) return;
			console.log('[price-updater] Watchdog: no snapshot for today after the scheduled slot — running update');
			checkAndUpdatePrices();
		} catch (err) {
			console.error('[price-updater] Watchdog check failed:', err);
		}
	}, WATCHDOG_INTERVAL_MS);

	// Catch-up: only trigger if the server was offline over yesterday's 18:00
	// slot so the daily history still has no entry for yesterday. Restarting
	// mid-morning on a normal day must NOT preempt today's scheduled 18:00 run
	// — otherwise the change-aware insert captures only the tiny overnight
	// diff and produces misleading "6 cards at 10am" days. Idempotent against
	// the main schedule via the run lock and the
	// UNIQUE(card_id, snapshot_date, language) upsert in runPriceUpdate.
	setTimeout(() => {
		try {
			if (isMissingYesterdaySnapshot()) {
				console.log('[price-updater] Missing snapshot for yesterday — running catch-up update');
				checkAndUpdatePrices();
			}
		} catch (err) {
			console.error('[price-updater] Catch-up check failed:', err);
		}
	}, 30_000);
}
// DISABLE_PRICE_UPDATES=1 keeps the catalogue and the price history frozen —
// for a second dev server on a seeded harness database, where the first
// catch-up run would otherwise import every Scryfall card into it.
if (process.env.DISABLE_PRICE_UPDATES === '1') {
	console.log('[price-updater] Disabled by DISABLE_PRICE_UPDATES=1');
} else {
	scheduleDailyPriceUpdate();
}

// Graceful shutdown so in-flight SQLite writes finish and the WAL flushes
// before the process exits. Without this, `docker stop` or `kubectl delete`
// SIGTERM would tear the process down mid-transaction after the 10s grace.
let shuttingDown = false;
function shutdown(signal: string) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`[shutdown] ${signal} received, closing DB`);
	try {
		sqlite.pragma('wal_checkpoint(TRUNCATE)');
		sqlite.close();
	} catch (err) {
		console.error('[shutdown] DB close failed:', err);
	}
	process.exit(0);
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

// /api/scan-log is public like /scan itself (its GET side checks for an admin on its own).
// '/decks' opens the public deck list, shared deck pages and their export to visitors; the
// deck loads hide private decks and show a visitor only the public list.
const publicRoutes = ['/login', '/auth/', '/cards', '/scan', '/portfolio-tracker', '/impressum', '/datenschutz', '/contact', '/api/health', '/api/scan-log', '/decks'];

// The CSP lives in src/lib/server/csp.ts (unit-tested against the scanner library hosts).

function withSecurityHeaders(response: Response): Response {
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), interest-cohort=()');
	response.headers.set('Content-Security-Policy', CSP);
	if (!dev) {
		response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	}
	return response;
}

export const handle: Handle = async ({ event, resolve }) => {
	const path = event.url.pathname;

	// SvelteKit runs this hook outside its error handling for a path it cannot decode
	// (/%c0), so the redirect or error thrown by the guard below would crash the
	// process. Such paths get SvelteKit's own answer, a 400, before anything can throw.
	if (!isDecodablePath(path)) {
		return withSecurityHeaders(text('Malformed URI', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } }));
	}

	const sessionId = event.cookies.get('session');
	event.locals.user = sessionId ? validateSession(sessionId) : null;

	// /collection/scan was the old upload-only scanner with its own pipeline;
	// /scan runs the shared pipeline (live camera, evidence fusion) and adds to
	// the collection when signed in. Old links and bookmarks land there.
	if (path === '/collection/scan' || path.startsWith('/collection/scan/')) {
		throw redirect(302, '/scan');
	}

	const isSitemap = path === '/sitemap.xml' || /^\/sitemap-[^/]+\.xml$/.test(path);
	const isPublic = isSitemap || publicRoutes.some(r => path === r || path.startsWith(r.endsWith('/') ? r : r + '/'));
	const isApi = path.startsWith('/cards/');

	if (!event.locals.user && !isPublic && !isApi && path !== '/') {
		if (path.startsWith('/api/')) {
			throw error(401, 'Unauthorized');
		}
		throw redirect(302, '/login');
	}

	if (path.startsWith('/admin') && (!event.locals.user || !event.locals.user.isAdmin)) {
		if (path.startsWith('/admin/api/')) {
			throw error(403, 'Forbidden');
		}
		throw redirect(302, '/');
	}

	return withSecurityHeaders(await resolve(event));
};
