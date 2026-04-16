import { json, error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { invalidateSessionCacheForUser } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ locals, cookies }) => {
	if (!locals.user) {
		throw error(401, 'Unauthorized');
	}

	const userId = locals.user.id;

	// Delete sessions first, then the user row. Without this, other devices of
	// the same account could still hit cached SessionUsers (5 min TTL) for a
	// window even though the DB-side CASCADE eventually purges the rows.
	sqlite.transaction(() => {
		sqlite.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
		sqlite.prepare('DELETE FROM users WHERE id = ?').run(userId);
	})();

	invalidateSessionCacheForUser(userId);
	cookies.delete('session', { path: '/' });

	return json({ success: true });
};
