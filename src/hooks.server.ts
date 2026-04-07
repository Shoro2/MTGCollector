import { initDb } from '$lib/server/db';
import { checkAndUpdatePrices } from '$lib/server/price-updater';
import { validateSession } from '$lib/server/auth';
import { error, redirect, type Handle } from '@sveltejs/kit';

// Initialize database tables on server start
initDb();

// Run price check shortly after server start (deferred to avoid SSR fetch warning)
setTimeout(() => {
	console.log('[price-updater] Running startup price check...');
	checkAndUpdatePrices();
}, 5000);

// Schedule daily price update at 18:00
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
		// Schedule next run in 24h
		setInterval(() => checkAndUpdatePrices(), 24 * 60 * 60 * 1000);
	}, msUntilNext);
}
scheduleDailyPriceUpdate();

// Routes that don't require authentication
const publicRoutes = ['/login', '/auth/', '/cards', '/scan', '/impressum', '/datenschutz', '/contact'];

export const handle: Handle = async ({ event, resolve }) => {
	const sessionId = event.cookies.get('session');
	event.locals.user = sessionId ? validateSession(sessionId) : null;

	// Check if route requires auth
	const path = event.url.pathname;
	const isPublic = publicRoutes.some(r => path === r || path.startsWith(r.endsWith('/') ? r : r + '/'));
	const isApi = path.startsWith('/cards/'); // card detail pages are public

	if (!event.locals.user && !isPublic && !isApi && path !== '/') {
		if (path.startsWith('/api/')) {
			throw error(401, 'Unauthorized');
		}
		throw redirect(302, '/login');
	}

	// Admin routes
	if (path.startsWith('/admin') && (!event.locals.user || !event.locals.user.isAdmin)) {
		if (path.startsWith('/admin/api/')) {
			throw error(403, 'Forbidden');
		}
		throw redirect(302, '/');
	}

	return resolve(event);
};
