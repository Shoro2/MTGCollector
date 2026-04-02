import { json } from '@sveltejs/kit';
import { getPriceUpdateStatus, runPriceUpdate } from '$lib/server/price-updater';

export async function GET() {
	return json(getPriceUpdateStatus());
}

export async function POST() {
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
