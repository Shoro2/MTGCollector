/**
 * In-memory index of the art hashes for the scanner's visual channel
 * (Phase 3, WP3.2). The whole table (~115k printings plus double-faced back
 * faces) fits in a few megabytes, and a Hamming scan over it takes about a
 * millisecond, so the search runs on the server: the phone sends the 16-hex
 * hash of its warped card, never downloads the table. Rebuilt when the number
 * of hashed rows changes (the hash job or an import ran).
 */
import { sqlite } from './db.js';
import { hammingDistance } from '../scanner/phash.js';

export type HashEntry = { key: string; hash: string };
export type HashMatch = HashEntry & { distance: number };

const HEX = /^[0-9a-f]{16}$/;

/** Entries within `maxDistance` bits of `hash`, nearest first, at most `limit`. Malformed hashes on either side never match. */
export function searchHashes(entries: readonly HashEntry[], hash: string, maxDistance: number, limit: number): HashMatch[] {
	if (!HEX.test(hash)) return [];
	const out: HashMatch[] = [];
	for (const e of entries) {
		if (!HEX.test(e.hash)) continue;
		const distance = hammingDistance(e.hash, hash);
		if (distance <= maxDistance) out.push({ ...e, distance });
	}
	out.sort((a, b) => a.distance - b.distance || (a.key < b.key ? -1 : 1));
	return out.slice(0, limit);
}

let cache: { count: number; entries: HashEntry[] } | null = null;

/** Every stored hash: cards keyed by id, back faces keyed by `id:faceIndex`. */
export function artIndex(): HashEntry[] {
	const count = (sqlite.prepare(`SELECT (SELECT COUNT(*) FROM cards WHERE art_hash IS NOT NULL) + (SELECT COUNT(*) FROM card_faces WHERE art_hash IS NOT NULL) AS n`).get() as { n: number }).n;
	if (cache && cache.count === count) return cache.entries;
	const entries: HashEntry[] = [];
	for (const r of sqlite.prepare(`SELECT id, art_hash FROM cards WHERE art_hash IS NOT NULL AND length(art_hash) = 16`).iterate() as Iterable<{ id: string; art_hash: string }>) entries.push({ key: r.id, hash: r.art_hash });
	for (const r of sqlite.prepare(`SELECT card_id, face_index, art_hash FROM card_faces WHERE art_hash IS NOT NULL AND length(art_hash) = 16`).iterate() as Iterable<{ card_id: string; face_index: number; art_hash: string }>) entries.push({ key: `${r.card_id}:${r.face_index}`, hash: r.art_hash });
	cache = { count, entries };
	return entries;
}

export type ArtSearchHit = { id: string; face: number; distance: number; rotated: boolean };

/**
 * Nearest printings for a card's art hash and, optionally, the hash of the
 * 180°-rotated warp (a card that came out of the warp upside down). One hit
 * per printing, the better orientation kept.
 */
export function searchArt(hash: string, alt: string | undefined, maxDistance: number, limit: number): ArtSearchHit[] {
	const entries = artIndex();
	const byKey = new Map<string, ArtSearchHit>();
	const add = (m: HashMatch, rotated: boolean) => {
		const [id, face] = m.key.split(':');
		const prev = byKey.get(m.key);
		if (!prev || m.distance < prev.distance) byKey.set(m.key, { id, face: face ? Number(face) : 0, distance: m.distance, rotated });
	};
	for (const m of searchHashes(entries, hash, maxDistance, limit)) add(m, false);
	if (alt) for (const m of searchHashes(entries, alt, maxDistance, limit)) add(m, true);
	return [...byKey.values()].sort((a, b) => a.distance - b.distance).slice(0, limit);
}
