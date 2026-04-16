import { sqlite } from './db.js';
import { priceDataCache, setsCache } from './cache.js';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseScryfallBulkStream } from './bulk-stream.js';

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

function getLastBulkUpdate(): string | null {
	try {
		if (existsSync(lastBulkUpdatePath)) {
			return readFileSync(lastBulkUpdatePath, 'utf-8').trim();
		}
	} catch { /* ignore */ }
	return null;
}


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

export async function runPriceUpdate(): Promise<{ updated: number; snapshotted: number }> {
	if (updateInProgress) {
		throw new Error('Price update already in progress');
	}

	updateInProgress = true;
	console.log('[price-updater] Starting price update...');

	try {
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

		// Stream-parse the bulk file so memory doesn't spike to ~1.2 GB on
		// the 600 MB payload. We apply price updates in batched transactions.
		const updatePrice = sqlite.prepare(
			'UPDATE cards SET price_eur = ?, price_eur_foil = ?, price_usd = ?, price_usd_foil = ? WHERE id = ?'
		);

		let updated = 0;
		let pendingBatch: ScryfallPriceCard[] = [];
		const batchSize = 5000;

		const applyBatch = () => {
			const batch = pendingBatch;
			pendingBatch = [];
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
		};

		for await (const card of parseScryfallBulkStream<ScryfallPriceCard>(priceDataPath)) {
			pendingBatch.push(card);
			if (pendingBatch.length >= batchSize) {
				applyBatch();
				await new Promise((resolve) => setImmediate(resolve));
			}
		}
		if (pendingBatch.length > 0) applyBatch();

		console.log(`[price-updater] Updated prices for ${updated} cards`);

		// Change-aware daily snapshot. Only inserts a new price_history row
		// when the card's current price differs from its most recent snapshot
		// (or there's no snapshot yet). The UNIQUE(card_id, DATE(recorded_at))
		// upsert guarantees at most one row per card per day even if this job
		// runs multiple times (e.g. after a restart or manual trigger).
		const now = new Date().toISOString();
		const snapshotResult = sqlite.prepare(`
			WITH last_snap AS (
				SELECT card_id, price_eur, price_eur_foil, price_usd, price_usd_foil
				FROM (
					SELECT card_id, price_eur, price_eur_foil, price_usd, price_usd_foil,
						ROW_NUMBER() OVER (PARTITION BY card_id ORDER BY recorded_at DESC, id DESC) AS rn
					FROM price_history
				) WHERE rn = 1
			)
			INSERT INTO price_history (card_id, price_eur, price_eur_foil, price_usd, price_usd_foil, recorded_at)
			SELECT c.id, c.price_eur, c.price_eur_foil, c.price_usd, c.price_usd_foil, ?
			FROM cards c
			LEFT JOIN last_snap l ON l.card_id = c.id
			WHERE (c.price_eur IS NOT NULL OR c.price_eur_foil IS NOT NULL OR c.price_usd IS NOT NULL OR c.price_usd_foil IS NOT NULL)
			  AND (
			    l.card_id IS NULL
			    OR c.price_eur IS NOT l.price_eur
			    OR c.price_eur_foil IS NOT l.price_eur_foil
			    OR c.price_usd IS NOT l.price_usd
			    OR c.price_usd_foil IS NOT l.price_usd_foil
			  )
			ON CONFLICT(card_id, DATE(recorded_at)) DO UPDATE SET
				price_eur = excluded.price_eur,
				price_eur_foil = excluded.price_eur_foil,
				price_usd = excluded.price_usd,
				price_usd_foil = excluded.price_usd_foil,
				recorded_at = excluded.recorded_at
		`).run(now);

		const snapshotted = snapshotResult.changes;
		console.log(`[price-updater] Snapshotted prices for ${snapshotted} cards (change-only)`);

		writeFileSync(lastBulkUpdatePath, defaultCards.updated_at, 'utf-8');

		if (existsSync(priceDataPath)) {
			await unlink(priceDataPath);
		}

		priceDataCache.invalidateAll();
		setsCache.invalidate();

		try {
			sqlite.pragma('optimize');
		} catch (err) {
			console.warn('[price-updater] PRAGMA optimize failed:', err);
		}

		console.log('[price-updater] Price update complete!');
		return { updated, snapshotted };
	} finally {
		updateInProgress = false;
	}
}


export function checkAndUpdatePrices(): void {
	const cardCount = sqlite.prepare('SELECT COUNT(*) as count FROM cards').get() as { count: number };
	if (cardCount.count === 0) {
		console.log('[price-updater] No cards in database, skipping price update');
		return;
	}

	runPriceUpdate().catch((err) => {
		console.error('[price-updater] Background price update failed:', err.message);
	});
}

/**
 * Did we miss a daily snapshot? Returns true if there's no price_history row
 * dated today (UTC) while at least one card has a price. The daily `setTimeout`
 * only fires at the next 18:00 UTC, so without this check a server that was
 * down for a day won't catch up until the day after tomorrow.
 */
export function isMissingTodaySnapshot(): boolean {
	const hasPriceableCard = sqlite.prepare(
		`SELECT 1 FROM cards
		 WHERE price_eur IS NOT NULL OR price_eur_foil IS NOT NULL
		    OR price_usd IS NOT NULL OR price_usd_foil IS NOT NULL
		 LIMIT 1`
	).get();
	if (!hasPriceableCard) return false;

	const today = sqlite.prepare(
		`SELECT 1 FROM price_history WHERE DATE(recorded_at) = DATE('now') LIMIT 1`
	).get();
	return !today;
}
