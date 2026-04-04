import { initDb } from '$lib/server/db';
import { checkAndUpdatePrices } from '$lib/server/price-updater';
import { validateSession } from '$lib/server/auth';
import { redirect, type Handle } from '@sveltejs/kit';

// Initialize database tables on server start
initDb();

// Check if prices need updating (runs in background, non-blocking)
setTimeout(() => checkAndUpdatePrices(), 5000);

// Routes that don't require authentication
const publicRoutes = ['/login', '/auth/', '/cards', '/scan', '/impressum', '/datenschutz'];

export const handle: Handle = async ({ event, resolve }) => {
	const sessionId = event.cookies.get('session');
	event.locals.user = sessionId ? validateSession(sessionId) : null;

	// Check if route requires auth
	const path = event.url.pathname;
	const isPublic = publicRoutes.some(r => path === r || path.startsWith(r));
	const isApi = path.startsWith('/cards/'); // card detail pages are public

	if (!event.locals.user && !isPublic && !isApi && path !== '/') {
		throw redirect(302, '/login');
	}

	// Admin routes
	if (path.startsWith('/admin') && (!event.locals.user || !event.locals.user.isAdmin)) {
		throw redirect(302, '/');
	}

	return resolve(event);
};
