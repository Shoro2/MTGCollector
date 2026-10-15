import type Database from 'better-sqlite3';
import { assignCardSlugs } from '../card-slug';

/**
 * Card-page slugs for the whole catalogue, kept in memory (~37k cards). Art-series
 * records are not cards and printings without an oracle id (reversible cards) have
 * no card to belong to; both keep only their printing pages.
 *
 * Rebuilt when MAX(rowid) moves: new cards from a price update are inserted with a
 * higher rowid (INSERT OR REPLACE too), and names of existing rows never change.
 */
export type CardSlugIndex = {
	bySlug: Map<string, string>;
	byOracle: Map<string, string>;
	/** Every slug, in a stable order (by oracle id), for the sitemap. */
	slugs: string[];
};

const TOKEN_LAYOUTS = "('token', 'double_faced_token', 'emblem')";

let cached: { db: Database.Database; marker: number; index: CardSlugIndex } | null = null;

export function cardSlugIndex(db: Database.Database): CardSlugIndex {
	const marker = (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM cards').get() as { m: number }).m;
	if (cached && cached.db === db && cached.marker === marker) return cached.index;
	const groups = (db.prepare(`
		SELECT oracle_id AS oracleId, MIN(name) AS name, MIN(COALESCE(layout, '') IN ${TOKEN_LAYOUTS}) AS token
		FROM cards
		WHERE oracle_id IS NOT NULL AND COALESCE(layout, '') != 'art_series'
		GROUP BY oracle_id
		ORDER BY oracle_id
	`).all() as Array<{ oracleId: string; name: string; token: number }>).map((g) => ({ ...g, token: g.token === 1 }));
	const byOracle = assignCardSlugs(groups);
	const bySlug = new Map<string, string>();
	for (const [oracleId, slug] of byOracle) bySlug.set(slug, oracleId);
	const index = { bySlug, byOracle, slugs: [...byOracle.values()] };
	cached = { db, marker, index };
	return index;
}
