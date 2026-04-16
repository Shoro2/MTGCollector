import { json } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';

export const GET = () => {
	try {
		const row = sqlite.prepare('SELECT 1 as ok').get() as { ok: number } | undefined;
		if (!row || row.ok !== 1) throw new Error('bad db response');
		return json({ ok: true, db: 'up' });
	} catch (err) {
		return json({ ok: false, error: err instanceof Error ? err.message : 'unknown' }, { status: 503 });
	}
};
