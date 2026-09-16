/**
 * Hamming search over art hashes (scanner Phase 3): the pure part of the
 * server's art index, kept free of the database so it can be unit-tested and
 * reused by the fusion. A 64-bit hash is 16 lower-case hex characters;
 * anything else never matches.
 */
import { hammingDistance } from './phash.js';

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
