import { sqlite } from '$lib/server/db';
import { getPriceUpdateStatus } from '$lib/server/price-updater';
import { redirect } from '@sveltejs/kit';
import { statSync } from 'node:fs';
import { join } from 'node:path';

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
			SELECT user_id, COUNT(*) as collection_count, COALESCE(SUM(quantity), 0) as total_cards
			FROM collection_cards GROUP BY user_id
		) cc ON cc.user_id = u.id
		LEFT JOIN (
			SELECT user_id, COUNT(*) as wishlist_count FROM wishlist_cards GROUP BY user_id
		) wl ON wl.user_id = u.id
		LEFT JOIN (
			SELECT user_id, COUNT(*) as active_sessions
			FROM sessions WHERE expires_at > datetime('now') GROUP BY user_id
		) sn ON sn.user_id = u.id
		ORDER BY u.created_at DESC LIMIT ? OFFSET ?`
	).all(USERS_PAGE_SIZE, offset) as Array<Record<string, unknown>>;

	// Database stats — one roundtrip instead of eight.
	const stats = sqlite.prepare(
		`SELECT
			(SELECT COUNT(*) FROM cards) as cardCount,
			(SELECT COUNT(*) FROM collection_cards) as collectionCount,
			(SELECT COUNT(*) FROM wishlist_cards) as wishlistCount,
			(SELECT COUNT(*) FROM price_history) as priceHistoryCount,
			(SELECT COUNT(*) FROM tags) as tagCount,
			(SELECT COUNT(*) FROM sessions) as sessionCount,
			(SELECT COUNT(*) FROM users) as userCount,
			(SELECT COUNT(*) FROM card_faces) as cardFaceCount`
	).get() as {
		cardCount: number; collectionCount: number; wishlistCount: number;
		priceHistoryCount: number; tagCount: number; sessionCount: number;
		userCount: number; cardFaceCount: number;
	};
	const { cardCount, collectionCount, wishlistCount, priceHistoryCount, tagCount, sessionCount, userCount, cardFaceCount } = stats;

	// Table sizes (row counts + estimated sizes)
	const tables = sqlite.prepare(
		`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
	).all() as Array<{ name: string }>;

	const tableStats = tables.map(t => {
		const count = (sqlite.prepare(`SELECT COUNT(*) as c FROM "${t.name}"`).get() as { c: number }).c;
		return { name: t.name, rows: count };
	});

	// DB file size
	let dbSizeMB = 0;
	try {
		const dbPath = join(process.cwd(), 'data', 'mtg.db');
		const stat = statSync(dbPath);
		dbSizeMB = Math.round(stat.size / 1024 / 1024 * 10) / 10;
	} catch { /* */ }

	// Price history date range
	const priceRange = sqlite.prepare(
		'SELECT MIN(recorded_at) as earliest, MAX(recorded_at) as latest FROM price_history'
	).get() as { earliest: string | null; latest: string | null };

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

	// Recent price history snapshots (unique dates)
	const recentSnapshots = sqlite.prepare(
		`SELECT DATE(recorded_at) as snapshot_date, COUNT(DISTINCT card_id) as cards_snapshotted
		 FROM price_history
		 GROUP BY DATE(recorded_at)
		 ORDER BY snapshot_date DESC
		 LIMIT 10`
	).all() as Array<{ snapshot_date: string; cards_snapshotted: number }>;

	// Google Vision API usage
	const visionUsage = {
		total: (sqlite.prepare(
			"SELECT COALESCE(SUM(request_count), 0) as c FROM api_usage WHERE service = 'google_vision'"
		).get() as { c: number }).c,
		totalImages: (sqlite.prepare(
			"SELECT COALESCE(SUM(image_count), 0) as c FROM api_usage WHERE service = 'google_vision'"
		).get() as { c: number }).c,
		thisMonth: (sqlite.prepare(
			"SELECT COALESCE(SUM(request_count), 0) as c FROM api_usage WHERE service = 'google_vision' AND created_at >= date('now', 'start of month')"
		).get() as { c: number }).c,
		thisMonthImages: (sqlite.prepare(
			"SELECT COALESCE(SUM(image_count), 0) as c FROM api_usage WHERE service = 'google_vision' AND created_at >= date('now', 'start of month')"
		).get() as { c: number }).c,
		recentCalls: sqlite.prepare(
			`SELECT created_at, request_count, image_count, user_id
			 FROM api_usage WHERE service = 'google_vision'
			 ORDER BY created_at DESC LIMIT 20`
		).all() as Array<{ created_at: string; request_count: number; image_count: number; user_id: string | null }>
	};

	return {
		users,
		usersPagination: {
			page,
			pageSize: USERS_PAGE_SIZE,
			total: userCount,
			totalPages: Math.max(1, Math.ceil(userCount / USERS_PAGE_SIZE))
		},
		visionUsage,
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
