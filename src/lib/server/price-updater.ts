import { sqlite } from './db.js';
import { priceDataCache } from './cache.js';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

// Use globalThis.fetch to avoid SvelteKit's SSR fetch warning
const nativeFetch = globalThis.fetch;

const dataDir = join(process.cwd(), 'data');
const priceDataPath = join(dataDir, 'scryfall-prices-temp.json');
const lastBulkUpdatePath = join(dataDir, 'last-bulk-update.txt');

let updateInProgress = false;

interface ScryfallPriceCard {
	id: string;
	prices: {
		eur?: string | null;
		eur_foil?: string | null;
		usd?: string | null;
		usd_foil?: string | null;
	};
}

/** Get the last known Scryfall bulk data updated_at timestamp */
function getLastBulkUpdate(): string | null {
	try {
		if (existsSync(lastBulkUpdatePath)) {
			return readFileSync(lastBulkUpdatePath, 'utf-8').trim();
		}
	} catch { /* ignore */ }
	return null;
}


/** Get status info about the price updater */
export function getPriceUpdateStatus(): { lastUpdate: string | null; inProgress: boolean; lastBulkUpdate: string | null } {
	const lastSnapshot = sqlite
		.prepare('SELECT recorded_at FROM price_history ORDER BY recorded_at DESC LIMIT 1')
		.get() as { recorded_at: string } | undefined;

	return {
		lastUpdate: lastSnapshot?.recorded_at ?? null,
		inProgress: updateInProgress,
		lastBulkUpdate: getLastBulkUpdate()
	};
}

/** Run a background price update - downloads bulk data and updates prices */
export async function runPriceUpdate(): Promise<{ updated: number; snapshotted: number }> {
	if (updateInProgress) {
		throw new Error('Price update already in progress');
	}

	updateInProgress = true;
	console.log('[price-updater] Starting price update...');

	try {
		// 1. Get bulk data download URL
		const bulkResponse = await nativeFetch('https://api.scryfall.com/bulk-data');
		if (!bulkResponse.ok) throw new Error(`Bulk data API failed: ${bulkResponse.status}`);

		const bulkData = await bulkResponse.json();
		const defaultCards = bulkData.data.find((d: { type: string }) => d.type === 'default_cards');
		if (!defaultCards) throw new Error('Could not find default_cards bulk data');

		console.log(`[price-updater] Downloading bulk data (${defaultCards.updated_at})...`);
		const downloadResponse = await nativeFetch(defaultCards.download_uri);
		if (!downloadResponse.ok || !downloadResponse.body) {
			throw new Error(`Download failed: ${downloadResponse.status}`);
		}

		mkdirSync(dataDir, { recursive: true });
		const fileStream = createWriteStream(priceDataPath);
		// @ts-expect-error Node.js ReadableStream compatibility
		await pipeline(downloadResponse.body, fileStream);
		console.log('[price-updater] Download complete, parsing prices...');

		// 2. Parse and update prices
		const fileContent = await readFile(priceDataPath, 'utf-8');
		const allCards: ScryfallPriceCard[] = JSON.parse(fileContent);

		const updatePrice = sqlite.prepare(
			'UPDATE cards SET price_eur = ?, price_eur_foil = ?, price_usd = ?, price_usd_foil = ? WHERE id = ?'
		);

		let updated = 0;
		const batchSize = 5000;

		for (let i = 0; i < allCards.length; i += batchSize) {
			const batch = allCards.slice(i, i + batchSize);
			const transaction = sqlite.transaction(() => {
				for (const card of batch) {
					const priceEur = card.prices?.eur ? parseFloat(card.prices.eur) : null;
					const priceEurFoil = card.prices?.eur_foil ? parseFloat(card.prices.eur_foil) : null;
					const priceUsd = card.prices?.usd ? parseFloat(card.prices.usd) : null;
					const priceUsdFoil = card.prices?.usd_foil ? parseFloat(card.prices.usd_foil) : null;

					const result = updatePrice.run(priceEur, priceEurFoil, priceUsd, priceUsdFoil, card.id);
					if (result.changes > 0) updated++;
				}
			});
			transaction();
			// Yield to event loop between batches so HTTP requests can be processed
			await new Promise((resolve) => setImmediate(resolve));
		}

		console.log(`[price-updater] Updated prices for ${updated} cards`);

		// 3. Snapshot prices for ALL cards
		const now = new Date().toISOString();
		const snapshotResult = sqlite.prepare(`
			INSERT INTO price_history (card_id, price_eur, price_eur_foil, price_usd, price_usd_foil, recorded_at)
			SELECT id, price_eur, price_eur_foil, price_usd, price_usd_foil, ?
			FROM cards
			WHERE price_eur IS NOT NULL OR price_eur_foil IS NOT NULL OR price_usd IS NOT NULL OR price_usd_foil IS NOT NULL
		`).run(now);

		const snapshotted = snapshotResult.changes;
		console.log(`[price-updater] Snapshotted prices for ${snapshotted} cards`);

		// 4. Save the bulk data version we just processed
		writeFileSync(lastBulkUpdatePath, defaultCards.updated_at, 'utf-8');

		// 5. Cleanup temp file
		if (existsSync(priceDataPath)) {
			await unlink(priceDataPath);
		}

		// Invalidate cached price data for all users
		priceDataCache.invalidateAll();

		console.log('[price-updater] Price update complete!');
		return { updated, snapshotted };
	} finally {
		updateInProgress = false;
	}
}


/** Run price update (non-blocking) */
export function checkAndUpdatePrices(): void {
	// Check if we have any cards in the DB at all
	const cardCount = sqlite.prepare('SELECT COUNT(*) as count FROM cards').get() as { count: number };
	if (cardCount.count === 0) {
		console.log('[price-updater] No cards in database, skipping price update');
		return;
	}

	runPriceUpdate().catch((err) => {
		console.error('[price-updater] Background price update failed:', err.message);
	});
}
