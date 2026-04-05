import { json, error } from '@sveltejs/kit';
import { initDb } from '$lib/server/db';

export async function POST({ locals }) {
	if (!locals.user?.isAdmin) {
		throw error(403, 'Forbidden');
	}

	try {
		initDb();
		return json({ success: true, message: 'Database initialized. Run npm run import-cards to import card data.' });
	} catch (err) {
		return json({ success: false, message: String(err) }, { status: 500 });
	}
}
