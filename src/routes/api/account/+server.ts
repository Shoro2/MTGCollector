import { json, error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ locals, cookies }) => {
	if (!locals.user) {
		throw error(401, 'Unauthorized');
	}

	sqlite.prepare('DELETE FROM users WHERE id = ?').run(locals.user.id);

	cookies.delete('session', { path: '/' });

	return json({ success: true });
};
