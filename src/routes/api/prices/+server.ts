import { json, error } from '@sveltejs/kit';
import { getPriceUpdateStatus, runPriceUpdate } from '$lib/server/price-updater';

export async function GET() {
	const status = getPriceUpdateStatus();
	return json(status);
}

export async function POST({ locals }) {
	if (!locals.user?.isAdmin) {
		throw error(403, 'Forbidden');
	}

	const status = getPriceUpdateStatus();
	if (status.inProgress) {
		return json({ success: false, message: 'Update already in progress' }, { status: 409 });
	}

	// Run in background
	runPriceUpdate()
		.then((result) => {
			console.log(`[api/prices] Update done: ${result.updated} prices updated, ${result.snapshotted} snapshots`);
		})
		.catch((err) => {
			console.error('[api/prices] Update failed:', err.message);
		});

	return json({ success: true, message: 'Price update started' });
}
