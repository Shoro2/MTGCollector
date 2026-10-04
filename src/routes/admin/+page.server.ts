import { sqlite } from '$lib/server/db';
import { getPriceUpdateStatus } from '$lib/server/price-updater';
import { redirect } from '@sveltejs/kit';
import { statSync } from 'node:fs';
import { recentSnapshots as loadRecentSnapshots, priceHistoryRange } from '$lib/server/admin-stats';

const USERS_PAGE_SIZE = 50;

export async function load({ locals, url }) {
	if (!locals.user?.isAdmin) throw redirect(302, '/');

	// Users — paginated to stay responsive with large user counts. Aggregates
	// are pulled via LEFT JOIN on grouped subqueries so the engine visits each
	// dependent table once instead of once per user row (as scalar subqueries
	// would force).
	const page = Math.max(1, parseInt(url.searchParams.get('usersPage') || '1') || 1);
	const offset = (page - 1) * USERS_PAGE_SIZE;
	const users = sqlite.prepare(
		`SELECT u.id, u.name, u.email, u.avatar_url, u.created_at,
			COALESCE(cc.collection_count, 0) as collection_count,
			COALESCE(cc.total_cards, 0) as total_cards,
			COALESCE(wl.wishlist_count, 0) as wishlist_count,
			COALESCE(sn.active_sessions, 0) as active_sessions
		FROM users u
		LEFT JOIN (
			SELECT user_id, COUNT(DISTINCT card_id) as collection_count, COALESCE(SUM(quantity), 0) as total_cards
			FROM collection_cards GROUP BY user_id
		) cc ON cc.user_id = u.id
		LEFT JOIN (
			SELECT user_id, COUNT(*) as wishlist_count FROM wishlist_cards GROUP BY user_id
		) wl ON wl.user_id = u.id
		LEFT JOIN (
			SELECT user_id, COUNT(*) as active_sessions
			FROM sessions WHERE expires_at > ? GROUP BY user_id
		) sn ON sn.user_id = u.id
		ORDER BY u.created_at DESC LIMIT ? OFFSET ?`
	).all(new Date().toISOString(), USERS_PAGE_SIZE, offset) as Array<Record<string, unknown>>;

	// Count each table once. FTS shadow tables are implementation details.
	const tables = sqlite.prepare(
		`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
		 AND name NOT LIKE 'cards_fts_%' AND name != 'cards_fts' ORDER BY name`
	).all() as Array<{ name: string }>;
	const tableStats = tables.map(({ name }) => ({ name,
		rows: (sqlite.prepare(`SELECT COUNT(*) AS c FROM "${name.replaceAll('"', '""')}"`).get() as { c: number }).c
	}));
	const counts = new Map(tableStats.map(t => [t.name, t.rows]));
	const cardCount = counts.get('cards') ?? 0;
	const collectionCount = counts.get('collection_cards') ?? 0;
	const wishlistCount = counts.get('wishlist_cards') ?? 0;
	const priceHistoryCount = counts.get('price_history') ?? 0;
	const tagCount = counts.get('tags') ?? 0;
	const sessionCount = counts.get('sessions') ?? 0;
	const userCount = counts.get('users') ?? 0;
	const cardFaceCount = counts.get('card_faces') ?? 0;

	// Include committed WAL data, and respect MTG_DB_PATH via the connection.
	let dbBytes = 0;
	for (const path of [sqlite.name, `${sqlite.name}-wal`]) {
		try { dbBytes += statSync(path).size; } catch { /* No WAL, or in-memory DB. */ }
	}
	const dbSizeMB = Math.round(dbBytes / 1024 / 1024 * 10) / 10;
	const priceRange = priceHistoryRange(sqlite);

	// Top sets by card count
	const topSets = sqlite.prepare(
		'SELECT set_name, set_code, COUNT(*) as count FROM cards GROUP BY set_code ORDER BY count DESC LIMIT 15'
	).all() as Array<Record<string, unknown>>;

	// Contact form messages (most recent 50)
	const contactMessages = sqlite.prepare(
		`SELECT id, name, email, subject, message, handled, created_at
		 FROM contact_messages
		 ORDER BY created_at DESC
		 LIMIT 50`
	).all() as Array<{
		id: number;
		name: string;
		email: string;
		subject: string | null;
		message: string;
		handled: number;
		created_at: string;
	}>;
	const unhandledContactCount = (sqlite.prepare(
		'SELECT COUNT(*) as c FROM contact_messages WHERE handled = 0'
	).get() as { c: number }).c;

	// Price update status
	const priceStatus = getPriceUpdateStatus();

	const recentSnapshots = loadRecentSnapshots(sqlite);

	return {
		users,
		usersPagination: {
			page,
			pageSize: USERS_PAGE_SIZE,
			total: userCount,
			totalPages: Math.max(1, Math.ceil(userCount / USERS_PAGE_SIZE))
		},
		dbStats: {
			cardCount,
			collectionCount,
			wishlistCount,
			priceHistoryCount,
			tagCount,
			sessionCount,
			userCount,
			cardFaceCount,
			dbSizeMB,
			priceRange,
			tableStats
		},
		topSets,
		priceStatus,
		recentSnapshots,
		contactMessages,
		unhandledContactCount
	};
}
