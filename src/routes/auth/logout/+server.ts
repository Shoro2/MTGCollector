import { redirect } from '@sveltejs/kit';
import { deleteSession } from '$lib/server/auth';

export async function POST({ cookies }) {
	const sessionId = cookies.get('session');
	if (sessionId) {
		deleteSession(sessionId);
		cookies.delete('session', { path: '/' });
	}
	throw redirect(302, '/login');
}
