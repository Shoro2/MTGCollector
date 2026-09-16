/**
 * Art-hash index (scanner Phase 3, WP3.1): a 64-bit perceptual hash of the
 * art region of every printing's Scryfall image, stored in `cards.art_hash`
 * (and `card_faces.art_hash` for the back faces of double-faced cards) so the
 * scanner can match a photographed card by its picture instead of its OCR'd
 * name. Images are fetched one at a time with the catalogue's usual 200 ms
 * spacing and discarded after hashing; only the 16-character hash stays.
 *
 * Resumable and incremental: rows whose hash is NULL are processed, rows
 * whose fetch or decode failed are marked ART_HASH_FAILED and only retried on
 * request. The initial backfill of ~115k printings takes about 6.5 hours;
 * later runs only touch new cards. `exportArtHashes` / `importArtHashes`
 * move the hashes between databases (dev PC -> host) as a small JSON file.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { sqlite } from './db.js';
import { hashImageUrl } from './art-image.js';

export { smallImageUrl, hashImageBytes, fetchImage, hashImageUrl } from './art-image.js';

/** Stored instead of a hash when the image could not be fetched or decoded. */
export const ART_HASH_FAILED = '-';
export const DEFAULT_DELAY_MS = 200;

export type ArtHashJobOptions = {
	/** Stop after this many rows (cards + faces); 0 = all. */
	limit?: number;
	delayMs?: number;
	/** Also process rows marked ART_HASH_FAILED. */
	retryFailed?: boolean;
	/** Skip the back faces of double-faced cards. */
	skipFaces?: boolean;
	/** Only these set codes (a new set on release, or the sets a measurement needs first). */
	sets?: string[];
	log?: (line: string) => void;
};

type Target = { kind: 'card' | 'face'; id: string; faceIndex: number; imageUri: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pendingTargets(retryFailed: boolean, skipFaces: boolean, sets: string[] = []): Target[] {
	const cond = retryFailed ? `(art_hash IS NULL OR art_hash = '${ART_HASH_FAILED}')` : 'art_hash IS NULL';
	const setFilter = sets.length > 0 ? ` AND set_code IN (${sets.map(() => '?').join(',')})` : '';
	const setArgs = sets.map((s) => s.toLowerCase());
	const cards = sqlite
		.prepare(`SELECT id, image_uri FROM cards WHERE image_uri IS NOT NULL AND image_uri <> '' AND layout <> 'art_series' AND ${cond}${setFilter} ORDER BY released_at DESC, id`)
		.all(...setArgs) as Array<{ id: string; image_uri: string }>;
	const targets: Target[] = cards.map((c) => ({ kind: 'card', id: c.id, faceIndex: 0, imageUri: c.image_uri }));
	if (!skipFaces) {
		// Face 0 shares the card's own image; the back faces have their own.
		const faces = sqlite
			.prepare(`SELECT f.card_id, f.face_index, f.image_uri FROM card_faces f JOIN cards c ON c.id = f.card_id WHERE f.face_index > 0 AND f.image_uri IS NOT NULL AND f.image_uri <> '' AND c.layout <> 'art_series' AND ${cond.replace(/art_hash/g, 'f.art_hash')}${setFilter.replace('set_code', 'c.set_code')} ORDER BY c.released_at DESC, f.card_id, f.face_index`)
			.all(...setArgs) as Array<{ card_id: string; face_index: number; image_uri: string }>;
		for (const f of faces) targets.push({ kind: 'face', id: f.card_id, faceIndex: f.face_index, imageUri: f.image_uri });
	}
	return targets;
}

/** Hash every pending printing (and back face); returns the counts. */
export async function runArtHashJob(opts: ArtHashJobOptions = {}): Promise<{ hashed: number; failed: number; total: number }> {
	const log = opts.log ?? (() => {});
	const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
	const targets = pendingTargets(!!opts.retryFailed, !!opts.skipFaces, opts.sets ?? []);
	const total = opts.limit && opts.limit > 0 ? Math.min(opts.limit, targets.length) : targets.length;
	log(`${targets.length} image(s) pending (${targets.filter((t) => t.kind === 'face').length} back faces), processing ${total} with ${delayMs} ms between requests`);
	const setCard = sqlite.prepare('UPDATE cards SET art_hash = ? WHERE id = ?');
	const setFace = sqlite.prepare('UPDATE card_faces SET art_hash = ? WHERE card_id = ? AND face_index = ?');
	const store = (t: Target, hash: string) => (t.kind === 'card' ? setCard.run(hash, t.id) : setFace.run(hash, t.id, t.faceIndex));
	let hashed = 0;
	let failed = 0;
	const started = Date.now();
	for (let i = 0; i < total; i++) {
		const t = targets[i];
		const t0 = Date.now();
		try {
			const hash = await hashImageUrl(t.imageUri);
			if (hash) {
				store(t, hash);
				hashed++;
			} else {
				store(t, ART_HASH_FAILED);
				failed++;
				log(`no image for ${t.kind} ${t.id}${t.kind === 'face' ? `/${t.faceIndex}` : ''}: ${t.imageUri}`);
			}
		} catch (err) {
			store(t, ART_HASH_FAILED);
			failed++;
			log(`failed ${t.kind} ${t.id}${t.kind === 'face' ? `/${t.faceIndex}` : ''}: ${(err as Error).message}`);
		}
		if ((i + 1) % 500 === 0 || i + 1 === total) {
			const elapsed = (Date.now() - started) / 1000;
			const rate = (i + 1) / elapsed;
			const eta = Math.round((total - i - 1) / Math.max(rate, 1e-6));
			log(`${i + 1}/${total} done (${hashed} hashed, ${failed} failed), ${rate.toFixed(1)}/s, ETA ${Math.round(eta / 60)} min`);
		}
		const spent = Date.now() - t0;
		if (spent < delayMs && i + 1 < total) await sleep(delayMs - spent);
	}
	return { hashed, failed, total };
}

export type ArtHashExport = { cards: Record<string, string>; faces: Record<string, string> };

/** Every stored hash (failures excluded) keyed by Scryfall id; faces as `id:index`. */
export function exportArtHashes(path: string): { cards: number; faces: number } {
	const out: ArtHashExport = { cards: {}, faces: {} };
	for (const r of sqlite.prepare(`SELECT id, art_hash FROM cards WHERE art_hash IS NOT NULL AND art_hash <> '${ART_HASH_FAILED}'`).iterate() as Iterable<{ id: string; art_hash: string }>) out.cards[r.id] = r.art_hash;
	for (const r of sqlite.prepare(`SELECT card_id, face_index, art_hash FROM card_faces WHERE art_hash IS NOT NULL AND art_hash <> '${ART_HASH_FAILED}'`).iterate() as Iterable<{ card_id: string; face_index: number; art_hash: string }>) out.faces[`${r.card_id}:${r.face_index}`] = r.art_hash;
	writeFileSync(path, JSON.stringify(out));
	return { cards: Object.keys(out.cards).length, faces: Object.keys(out.faces).length };
}

/** Fill hashes from an export into rows that have none yet; existing hashes are kept. */
export function importArtHashes(path: string): { cards: number; faces: number } {
	if (!existsSync(path)) throw new Error(`no such file: ${path}`);
	const data = JSON.parse(readFileSync(path, 'utf8')) as ArtHashExport;
	const setCard = sqlite.prepare(`UPDATE cards SET art_hash = ? WHERE id = ? AND (art_hash IS NULL OR art_hash = '${ART_HASH_FAILED}')`);
	const setFace = sqlite.prepare(`UPDATE card_faces SET art_hash = ? WHERE card_id = ? AND face_index = ? AND (art_hash IS NULL OR art_hash = '${ART_HASH_FAILED}')`);
	let cards = 0;
	let faces = 0;
	sqlite.transaction(() => {
		for (const [id, hash] of Object.entries(data.cards ?? {})) if (/^[0-9a-f]{16}$/.test(hash)) cards += setCard.run(hash, id).changes;
		for (const [key, hash] of Object.entries(data.faces ?? {})) {
			const [id, index] = key.split(':');
			if (/^[0-9a-f]{16}$/.test(hash)) faces += setFace.run(hash, id, Number(index)).changes;
		}
	})();
	return { cards, faces };
}

/** Counts for the status line. */
export function artHashStatus(): { hashed: number; failed: number; pending: number; faces: number } {
	const row = sqlite.prepare(`SELECT
		SUM(CASE WHEN art_hash IS NOT NULL AND art_hash <> '${ART_HASH_FAILED}' THEN 1 ELSE 0 END) AS hashed,
		SUM(CASE WHEN art_hash = '${ART_HASH_FAILED}' THEN 1 ELSE 0 END) AS failed,
		SUM(CASE WHEN art_hash IS NULL AND image_uri IS NOT NULL AND image_uri <> '' AND layout <> 'art_series' THEN 1 ELSE 0 END) AS pending
		FROM cards`).get() as { hashed: number; failed: number; pending: number };
	const faces = (sqlite.prepare(`SELECT COUNT(*) AS n FROM card_faces WHERE art_hash IS NOT NULL AND art_hash <> '${ART_HASH_FAILED}'`).get() as { n: number }).n;
	return { hashed: row.hashed ?? 0, failed: row.failed ?? 0, pending: row.pending ?? 0, faces };
}
