import { sqlite, initDb } from '$lib/server/db';
import { checkAndUpdatePrices, isMissingTodaySnapshot } from '$lib/server/price-updater';
import { validateSession } from '$lib/server/auth';
import { error, redirect, type Handle } from '@sveltejs/kit';
import { dev } from '$app/environment';

initDb();

function scheduleDailyPriceUpdate() {
	const now = new Date();
	const next = new Date(now);
	next.setHours(18, 0, 0, 0);
	if (now >= next) {
		next.setDate(next.getDate() + 1);
	}
	const msUntilNext = next.getTime() - now.getTime();
	console.log(`[price-updater] Next price update scheduled at ${next.toISOString()} (in ${Math.round(msUntilNext / 1000 / 60)} minutes)`);
	setTimeout(() => {
		checkAndUpdatePrices();
		setInterval(() => checkAndUpdatePrices(), 24 * 60 * 60 * 1000);
	}, msUntilNext);

	// Catch-up: if the server was offline over a scheduled 18:00 UTC slot,
	// today's snapshot is missing. Run an update ~30s after boot (idempotent
	// against the main schedule thanks to the `updateInProgress` guard and the
	// UNIQUE(card_id, DATE(recorded_at)) upsert in runPriceUpdate).
	setTimeout(() => {
		try {
			if (isMissingTodaySnapshot()) {
				console.log('[price-updater] Missing snapshot for today — running catch-up update');
				checkAndUpdatePrices();
			}
		} catch (err) {
			console.error('[price-updater] Catch-up check failed:', err);
		}
	}, 30_000);
}
scheduleDailyPriceUpdate();

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

const publicRoutes = ['/login', '/auth/', '/cards', '/scan', '/impressum', '/datenschutz', '/contact', '/api/health'];

// Permissive CSP: the app loads OpenCV and Tesseract from CDNs and embeds a
// self-hosted Plausible script. 'unsafe-inline' is required by SvelteKit's
// hydration payloads; 'unsafe-eval' is required by OpenCV's WASM glue.
const CSP = [
	"default-src 'self'",
	"script-src 'self' 'unsafe-inline' 'unsafe-eval' https://docs.opencv.org https://cdn.jsdelivr.net https://analytics.mtg-collector.com",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob: https://cards.scryfall.io https://c1.scryfall.com https://c2.scryfall.com https://lh3.googleusercontent.com",
	"connect-src 'self' https://api.scryfall.com https://vision.googleapis.com https://api.frankfurter.dev https://analytics.mtg-collector.com",
	"font-src 'self' data:",
	"worker-src 'self' blob:",
	"frame-ancestors 'none'",
	"base-uri 'self'",
	"form-action 'self' https://accounts.google.com"
].join('; ');

export const handle: Handle = async ({ event, resolve }) => {
	const sessionId = event.cookies.get('session');
	event.locals.user = sessionId ? validateSession(sessionId) : null;

	const path = event.url.pathname;
	const isPublic = publicRoutes.some(r => path === r || path.startsWith(r.endsWith('/') ? r : r + '/'));
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

	const response = await resolve(event);

	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), interest-cohort=()');
	response.headers.set('Content-Security-Policy', CSP);
	if (!dev) {
		response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	}

	return response;
};
