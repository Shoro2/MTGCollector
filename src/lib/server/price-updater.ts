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
	oracle_id?: string;
	name: string;
	mana_cost?: string;
	cmc?: number;
	type_line?: string;
	oracle_text?: string;
	colors?: string[];
	color_identity?: string[];
	keywords?: string[];
	set: string;
	set_name: string;
	collector_number: string;
	rarity: string;
	power?: string;
	toughness?: string;
	loyalty?: string;
	image_uris?: { normal?: string; small?: string; large?: string };
	layout: string;
	legalities?: Record<string, string>;
	released_at?: string;
	scryfall_uri?: string;
	prices: {
		eur?: string | null;
		eur_foil?: string | null;
		usd?: string | null;
		usd_foil?: string | null;
	};
	cardmarket_id?: number;
	lang: string;
	card_faces?: Array<{
		name?: string;
		mana_cost?: string;
		type_line?: string;
		oracle_text?: string;
		image_uris?: { normal?: string };
		power?: string;
		toughness?: string;
	}>;
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

export async function runPriceUpdate(): Promise<{ updated: number; inserted: number; snapshotted: number }> {
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
			'UPDATE cards SET price_eur = ?, price_eur_foil = ?, price_usd = ?, price_usd_foil = ?, cardmarket_id = COALESCE(?, cardmarket_id) WHERE id = ?'
		);

		const cardExists = sqlite.prepare('SELECT 1 FROM cards WHERE id = ?');

		const insertCard = sqlite.prepare(`
			INSERT INTO cards (
				id, oracle_id, name, mana_cost, cmc, type_line, oracle_text,
				colors, color_identity, keywords, set_code, set_name,
				collector_number, rarity, power, toughness, loyalty,
				image_uri, layout, legalities, released_at, scryfall_uri,
				price_eur, price_eur_foil, price_usd, price_usd_foil, cardmarket_id
			) VALUES (
				?, ?, ?, ?, ?, ?, ?,
				?, ?, ?, ?, ?,
				?, ?, ?, ?, ?,
				?, ?, ?, ?, ?,
				?, ?, ?, ?, ?
			)
		`);

		const insertFace = sqlite.prepare(`
			INSERT INTO card_faces (
				card_id, face_index, name, mana_cost, type_line, oracle_text,
				image_uri, power, toughness
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		let updated = 0;
		let inserted = 0;
		let pendingBatch: ScryfallPriceCard[] = [];
		const batchSize = 5000;

		const applyBatch = () => {
			const batch = pendingBatch;
			pendingBatch = [];
			const transaction = sqlite.transaction(() => {
				for (const card of batch) {
					if (card.lang !== 'en') continue;

					const priceEur = card.prices?.eur ? parseFloat(card.prices.eur) : null;
					const priceEurFoil = card.prices?.eur_foil ? parseFloat(card.prices.eur_foil) : null;
					const priceUsd = card.prices?.usd ? parseFloat(card.prices.usd) : null;
					const priceUsdFoil = card.prices?.usd_foil ? parseFloat(card.prices.usd_foil) : null;
					const cardmarketId = card.cardmarket_id ?? null;

					if (cardExists.get(card.id)) {
						const result = updatePrice.run(priceEur, priceEurFoil, priceUsd, priceUsdFoil, cardmarketId, card.id);
						if (result.changes > 0) updated++;
						continue;
					}

					const imageUri =
						card.image_uris?.normal ||
						card.card_faces?.[0]?.image_uris?.normal ||
						null;

					insertCard.run(
						card.id,
						card.oracle_id || null,
						card.name,
						card.mana_cost || null,
						card.cmc ?? null,
						card.type_line || null,
						card.oracle_text || null,
						card.colors ? JSON.stringify(card.colors) : null,
						card.color_identity ? JSON.stringify(card.color_identity) : null,
						card.keywords ? JSON.stringify(card.keywords) : null,
						card.set,
						card.set_name,
						card.collector_number,
						card.rarity,
						card.power || null,
						card.toughness || null,
						card.loyalty || null,
						imageUri,
						card.layout,
						card.legalities ? JSON.stringify(card.legalities) : null,
						card.released_at || null,
						card.scryfall_uri || null,
						priceEur,
						priceEurFoil,
						priceUsd,
						priceUsdFoil,
						cardmarketId
					);
					inserted++;

					if (card.card_faces && card.card_faces.length > 1) {
						for (let fi = 0; fi < card.card_faces.length; fi++) {
							const face = card.card_faces[fi];
							insertFace.run(
								card.id,
								fi,
								face.name || null,
								face.mana_cost || null,
								face.type_line || null,
								face.oracle_text || null,
								face.image_uris?.normal || null,
								face.power || null,
								face.toughness || null
							);
						}
					}
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

		console.log(`[price-updater] Updated prices for ${updated} cards, inserted ${inserted} new cards`);

		// Change-aware daily snapshot. Only inserts a new price_history row
		// when the card's current price differs from its most recent snapshot
		// (or there's no snapshot yet). The UNIQUE(card_id, snapshot_date)
		// upsert guarantees at most one row per card per day even if this job
		// runs multiple times (e.g. after a restart or manual trigger).
		const now = new Date().toISOString();
		const snapshotDate = now.slice(0, 10);
		const snapshotResult = sqlite.prepare(`
			WITH last_snap AS (
				SELECT card_id, price_eur, price_eur_foil, price_usd, price_usd_foil
				FROM (
					SELECT card_id, price_eur, price_eur_foil, price_usd, price_usd_foil,
						ROW_NUMBER() OVER (PARTITION BY card_id ORDER BY recorded_at DESC, id DESC) AS rn
					FROM price_history
				) WHERE rn = 1
			)
			INSERT INTO price_history (card_id, price_eur, price_eur_foil, price_usd, price_usd_foil, recorded_at, snapshot_date)
			SELECT c.id, c.price_eur, c.price_eur_foil, c.price_usd, c.price_usd_foil, ?, ?
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
			ON CONFLICT(card_id, snapshot_date) DO UPDATE SET
				price_eur = excluded.price_eur,
				price_eur_foil = excluded.price_eur_foil,
				price_usd = excluded.price_usd,
				price_usd_foil = excluded.price_usd_foil,
				recorded_at = excluded.recorded_at
		`).run(now, snapshotDate);

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
		return { updated, inserted, snapshotted };
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
 * Did the server miss the previous day's scheduled snapshot? Returns true if
 * at least one card has a price but no price_history row exists for yesterday
 * (UTC). Used by the boot-time catch-up: we only want to trigger a premature
 * snapshot when we actually missed a 18:00 slot — not every time the server
 * restarts in the morning before today's slot has fired.
 */
export function isMissingYesterdaySnapshot(): boolean {
	const hasPriceableCard = sqlite.prepare(
		`SELECT 1 FROM cards
		 WHERE price_eur IS NOT NULL OR price_eur_foil IS NOT NULL
		    OR price_usd IS NOT NULL OR price_usd_foil IS NOT NULL
		 LIMIT 1`
	).get();
	if (!hasPriceableCard) return false;

	const yesterday = sqlite.prepare(
		`SELECT 1 FROM price_history WHERE snapshot_date = DATE('now', '-1 day') LIMIT 1`
	).get();
	return !yesterday;
}
