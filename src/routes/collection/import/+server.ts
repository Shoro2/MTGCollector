import { json, error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { priceDataCache, tagsCache } from '$lib/server/cache';
import { ensureForeignPricesSequential } from '$lib/server/foreign-prices';
import { parseCollectionImport } from '$lib/collection-import';
import { prepareCollectionImport, commitCollectionImport, type ImportMode } from '$lib/server/collection-import';

export async function POST({ request, locals }) {
	if (!locals.user) throw error(401, 'Not authenticated');
	try {
		const form = await request.formData();
		const format = form.get('format') === 'text' ? 'text' : 'csv';
		const file = form.get('file');
		if (file instanceof File && file.size > 10 * 1024 * 1024) throw new Error('CSV too large (maximum 10 MB).');
		const text = format === 'csv' && file instanceof File ? await file.text() : String(form.get('text') || '');
		if (new TextEncoder().encode(text).byteLength > 10 * 1024 * 1024) throw new Error('File too large (maximum 10 MB).');
		const parsed = parseCollectionImport(text, format, {
			mapping: form.get('mapping') ? JSON.parse(String(form.get('mapping'))) : undefined,
			currency: String(form.get('currency') || 'EUR'), location: String(form.get('location') || ''),
			ignorePrices: form.get('ignorePrices') === 'true'
		});
		const mode = String(form.get('mode') || 'merge') as ImportMode;
		if (form.get('action') === 'commit') {
			const result = commitCollectionImport(sqlite, locals.user.id, parsed, mode, String(form.get('digest') || ''), form.get('confirmReplace') === 'true');
			priceDataCache.invalidate(locals.user.id);
			tagsCache.invalidate(locals.user.id);
			ensureForeignPricesSequential(result.ready.map(row => ({ cardId: row.card.id, language: row.language }))).catch(() => {});
			return json({ success: true, imported: result.ready.length, copies: result.summary.copies, skipped: result.summary.skipped, issues: result.issues.length });
		}
		const plan = prepareCollectionImport(sqlite, locals.user.id, parsed, mode);
		return json({ success: true, headers: parsed.headers, mapping: parsed.mapping, digest: plan.digest,
			summary: plan.summary, rows: plan.entries.slice(0, 50).map(row => ({ line: row.line, name: row.card.name,
				set: row.card.set_code, number: row.card.collector_number, quantity: row.quantity, foil: row.foil, condition: row.condition,
				language: row.language, purchasePrice: row.purchasePrice, location: row.location, duplicate: row.duplicate })),
			issues: plan.issues.slice(0, 100) }, { headers: { 'Cache-Control': 'private, no-store' } });
	} catch (cause) {
		return json({ success: false, message: cause instanceof Error ? cause.message : 'Import failed.' }, { status: 400 });
	}
}
