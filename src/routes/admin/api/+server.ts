import { sqlite } from '$lib/server/db';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user?.isAdmin) throw error(403, 'Forbidden');

	const body = await request.json();
	const { action } = body;

	if (action === 'cleanup_sessions') {
		const result = sqlite.prepare('DELETE FROM sessions WHERE expires_at < datetime(\'now\')').run();
		return json({ success: true, message: `Cleaned up ${result.changes} expired sessions` });
	}

	if (action === 'mark_message_handled') {
		const id = Number(body.id);
		const handled = body.handled ? 1 : 0;
		if (!id) return json({ success: false, message: 'Missing id' }, { status: 400 });
		sqlite.prepare('UPDATE contact_messages SET handled = ? WHERE id = ?').run(handled, id);
		return json({ success: true });
	}

	if (action === 'delete_message') {
		const id = Number(body.id);
		if (!id) return json({ success: false, message: 'Missing id' }, { status: 400 });
		sqlite.prepare('DELETE FROM contact_messages WHERE id = ?').run(id);
		return json({ success: true });
	}

	return json({ success: false, message: 'Unknown action' }, { status: 400 });
};
