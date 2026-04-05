import { initDb } from '$lib/server/db';
import { checkAndUpdatePrices } from '$lib/server/price-updater';
import { validateSession } from '$lib/server/auth';
import { error, redirect, type Handle } from '@sveltejs/kit';

// Initialize database tables on server start
initDb();

// Check if prices need updating (runs in background, non-blocking)
// Note: Safe for single-instance deployment only. Multi-instance requires distributed locking.
setTimeout(() => checkAndUpdatePrices(), 5000);

// Routes that don't require authentication
const publicRoutes = ['/login', '/auth/', '/cards', '/scan', '/impressum', '/datenschutz'];

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
