import { json, error } from '@sveltejs/kit';
import { getPriceUpdateStatus, runPriceUpdate } from '$lib/server/price-updater';

let lastSkipped = false;

export async function GET() {
	const status = getPriceUpdateStatus();
	return json({ ...status, skipped: lastSkipped });
}

export async function POST({ locals }) {
	if (!locals.user?.isAdmin) {
		throw error(403, 'Forbidden');
	}

	const status = getPriceUpdateStatus();
	if (status.inProgress) {
		return json({ success: false, message: 'Update already in progress' }, { status: 409 });
	}

	lastSkipped = false;

	// Run in background
	runPriceUpdate()
		.then((result) => {
			if (result.updated === 0 && result.snapshotted === 0) {
				lastSkipped = true;
				console.log('[api/prices] No new data from Scryfall, snapshot already taken today');
			} else if (result.updated === 0 && result.snapshotted > 0) {
				console.log(`[api/prices] No new Scryfall data, but daily snapshot taken: ${result.snapshotted} cards`);
			} else {
				console.log(`[api/prices] Update done: ${result.updated} prices updated, ${result.snapshotted} snapshots`);
			}
		})
		.catch((err) => {
			console.error('[api/prices] Update failed:', err.message);
		});

	return json({ success: true, message: 'Price update started' });
}
