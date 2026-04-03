import { sqlite } from '$lib/server/db';

const conditionMap: Record<string, string> = {
	near_mint: 'Near Mint',
	lightly_played: 'Lightly Played',
	moderately_played: 'Moderately Played',
	heavily_played: 'Heavily Played',
	damaged: 'Damaged'
};

function csvField(val: string | number | null | undefined): string {
	return `"${String(val ?? '').replace(/"/g, '""')}"`;
}

export async function GET() {
	const items = sqlite
		.prepare(
			`SELECT cc.quantity, cc.condition, cc.foil, cc.added_at, cc.purchase_price,
				c.name, c.set_code, c.collector_number
			FROM collection_cards cc
			JOIN cards c ON cc.card_id = c.id
			ORDER BY c.name ASC`
		)
		.all() as Array<Record<string, unknown>>;

	const header = '"Count","Tradelist Count","Name","Edition","Condition","Language","Foil","Tags","Last Modified","Collector Number","Alter","Proxy","Purchase Price"';

	const rows = items.map((item) => {
		const qty = item.quantity as number;
		const name = (item.name as string).split(' // ')[0];
		const set = (item.set_code as string).toLowerCase();
		const condition = conditionMap[item.condition as string] || 'Near Mint';
		const foil = item.foil ? 'foil' : '';
		const addedAt = (item.added_at as string).replace('T', ' ').replace('Z', '0000');
		const collectorNum = item.collector_number as string;
		const purchasePrice = item.purchase_price != null ? String(item.purchase_price) : '';

		return [
			csvField(qty),
			csvField(qty),
			csvField(name),
			csvField(set),
			csvField(condition),
			csvField('English'),
			csvField(foil),
			csvField(''),
			csvField(addedAt),
			csvField(collectorNum),
			csvField('False'),
			csvField('False'),
			csvField(purchasePrice)
		].join(',');
	});

	const csv = [header, ...rows].join('\n');

	return new Response(csv, {
		headers: {
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition': 'attachment; filename="moxfield_collection.csv"'
		}
	});
}
