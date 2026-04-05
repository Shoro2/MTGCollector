import { sqlite } from '$lib/server/db';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user?.isAdmin) throw error(403, 'Forbidden');

	const { action } = await request.json();

	if (action === 'cleanup_sessions') {
		const result = sqlite.prepare('DELETE FROM sessions WHERE expires_at < datetime(\'now\')').run();
		return json({ success: true, message: `Cleaned up ${result.changes} expired sessions` });
	}

	return json({ success: false, message: 'Unknown action' }, { status: 400 });
};
