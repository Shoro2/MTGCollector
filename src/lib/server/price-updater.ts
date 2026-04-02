import { sqlite } from './db.js';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const dataDir = join(process.cwd(), 'data');
const priceDataPath = join(dataDir, 'scryfall-prices-temp.json');

let updateInProgress = false;

interface ScryfallPriceCard {
	id: string;
	prices: {
		eur?: string | null;
		eur_foil?: string | null;
	};
}

/** Check if prices need updating (last snapshot is from a previous day) */
export function pricesNeedUpdate(): boolean {
	const lastSnapshot = sqlite
		.prepare('SELECT recorded_at FROM price_history ORDER BY recorded_at DESC LIMIT 1')
		.get() as { recorded_at: string } | undefined;

	if (!lastSnapshot) return true;

	const lastDate = lastSnapshot.recorded_at.substring(0, 10); // "YYYY-MM-DD"
	const today = new Date().toISOString().substring(0, 10);

	return lastDate !== today;
}

/** Get status info about the price updater */
export function getPriceUpdateStatus(): { lastUpdate: string | null; inProgress: boolean } {
	const lastSnapshot = sqlite
		.prepare('SELECT recorded_at FROM price_history ORDER BY recorded_at DESC LIMIT 1')
		.get() as { recorded_at: string } | undefined;

	return {
		lastUpdate: lastSnapshot?.recorded_at ?? null,
		inProgress: updateInProgress
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
		// 1. Download bulk data
		const bulkResponse = await fetch('https://api.scryfall.com/bulk-data');
		if (!bulkResponse.ok) throw new Error(`Bulk data API failed: ${bulkResponse.status}`);

		const bulkData = await bulkResponse.json();
		const defaultCards = bulkData.data.find((d: { type: string }) => d.type === 'default_cards');
		if (!defaultCards) throw new Error('Could not find default_cards bulk data');

		console.log(`[price-updater] Downloading from ${defaultCards.download_uri}...`);
		const downloadResponse = await fetch(defaultCards.download_uri);
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
			'UPDATE cards SET price_eur = ?, price_eur_foil = ? WHERE id = ?'
		);

		let updated = 0;
		const batchSize = 5000;

		for (let i = 0; i < allCards.length; i += batchSize) {
			const batch = allCards.slice(i, i + batchSize);
			const transaction = sqlite.transaction(() => {
				for (const card of batch) {
					const priceEur = card.prices?.eur ? parseFloat(card.prices.eur) : null;
					const priceEurFoil = card.prices?.eur_foil ? parseFloat(card.prices.eur_foil) : null;

					const result = updatePrice.run(priceEur, priceEurFoil, card.id);
					if (result.changes > 0) updated++;
				}
			});
			transaction();
		}

		console.log(`[price-updater] Updated prices for ${updated} cards`);

		// 3. Snapshot prices for collection cards only
		const now = new Date().toISOString();
		const snapshotResult = sqlite.prepare(`
			INSERT INTO price_history (card_id, price_eur, price_eur_foil, recorded_at)
			SELECT c.id, c.price_eur, c.price_eur_foil, ?
			FROM cards c
			INNER JOIN collection_cards cc ON cc.card_id = c.id
			GROUP BY c.id
		`).run(now);

		const snapshotted = snapshotResult.changes;
		console.log(`[price-updater] Snapshotted prices for ${snapshotted} collection cards`);

		// 4. Cleanup temp file
		if (existsSync(priceDataPath)) {
			await unlink(priceDataPath);
		}

		console.log('[price-updater] Price update complete!');
		return { updated, snapshotted };
	} finally {
		updateInProgress = false;
	}
}

/** Check and run price update if needed (non-blocking) */
export function checkAndUpdatePrices(): void {
	if (!pricesNeedUpdate()) {
		console.log('[price-updater] Prices are up to date');
		return;
	}

	// Check if we have any cards in the DB at all
	const cardCount = sqlite.prepare('SELECT COUNT(*) as count FROM cards').get() as { count: number };
	if (cardCount.count === 0) {
		console.log('[price-updater] No cards in database, skipping price update');
		return;
	}

	console.log('[price-updater] Prices are outdated, starting background update...');

	// Run in background - don't block the server
	runPriceUpdate().catch((err) => {
		console.error('[price-updater] Background price update failed:', err.message);
	});
}
