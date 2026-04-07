import { sqlite } from '$lib/server/db';
import { getPriceUpdateStatus } from '$lib/server/price-updater';
import { redirect } from '@sveltejs/kit';
import { statSync } from 'node:fs';
import { join } from 'node:path';

export async function load({ locals }) {
	if (!locals.user?.isAdmin) throw redirect(302, '/');

	// Users
	const users = sqlite.prepare(
		`SELECT u.id, u.name, u.email, u.avatar_url, u.created_at,
			(SELECT COUNT(*) FROM collection_cards WHERE user_id = u.id) as collection_count,
			(SELECT COALESCE(SUM(quantity), 0) FROM collection_cards WHERE user_id = u.id) as total_cards,
			(SELECT COUNT(*) FROM wishlist_cards WHERE user_id = u.id) as wishlist_count,
			(SELECT COUNT(*) FROM sessions WHERE user_id = u.id AND expires_at > datetime('now')) as active_sessions
		FROM users u ORDER BY u.created_at DESC`
	).all() as Array<Record<string, unknown>>;

	// Database stats
	const cardCount = (sqlite.prepare('SELECT COUNT(*) as c FROM cards').get() as { c: number }).c;
	const collectionCount = (sqlite.prepare('SELECT COUNT(*) as c FROM collection_cards').get() as { c: number }).c;
	const wishlistCount = (sqlite.prepare('SELECT COUNT(*) as c FROM wishlist_cards').get() as { c: number }).c;
	const priceHistoryCount = (sqlite.prepare('SELECT COUNT(*) as c FROM price_history').get() as { c: number }).c;
	const tagCount = (sqlite.prepare('SELECT COUNT(*) as c FROM tags').get() as { c: number }).c;
	const sessionCount = (sqlite.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }).c;
	const userCount = (sqlite.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
	const cardFaceCount = (sqlite.prepare('SELECT COUNT(*) as c FROM card_faces').get() as { c: number }).c;

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
