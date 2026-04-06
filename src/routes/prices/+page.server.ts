import { getPriceUpdateStatus } from '$lib/server/price-updater';
import { redirect } from '@sveltejs/kit';

export async function load({ locals }) {
	if (!locals.user) throw redirect(302, '/login');

	const priceStatus = getPriceUpdateStatus();

	return { priceStatus };
}
