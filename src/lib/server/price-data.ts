import type { Database } from 'better-sqlite3';

interface Quote {
	price_eur: number | null;
	price_eur_foil: number | null;
	price_usd: number | null;
	price_usd_foil: number | null;
}
interface Holding extends Quote {
	id: string;
	collection_id: number;
	name: string;
	set_name: string;
	image_uri: string | null;
	local_image_path: string | null;
	language: string;
	quantity: number;
	foil: number;
	purchase_price: number | null;
	added_at: string | null;
	local_eur: number | null;
	local_eur_foil: number | null;
	local_usd: number | null;
	local_usd_foil: number | null;
}
interface Snapshot extends Quote { card_id: string; language: string; snapshot_date: string }
export interface ProfitPoint {
	recorded_at: string;
	total_value: number | null;
	total_purchase: number | null;
	missing_market_count: number;
	estimated_count: number;
}

// Preserve the catalogue's EUR-first policy, including its English reference
// fallback. Mark that fallback whenever it supplies the value actually used.
function prices(base: Quote | undefined, local: Quote | undefined, foil: number, foreign: boolean) {
	const ownEur = foil ? local?.price_eur_foil : local?.price_eur;
	const ownUsd = foil ? local?.price_usd_foil : local?.price_usd;
	const baseEur = foil ? base?.price_eur_foil : base?.price_eur;
	const baseUsd = foil ? base?.price_usd_foil : base?.price_usd;
	return {
		price: ownEur ?? baseEur ?? null,
		price_usd: ownUsd ?? baseUsd ?? null,
		estimated: foreign && ownEur == null && (baseEur != null || (ownUsd == null && baseUsd != null))
	};
}
function inEur(quote: { price: number | null; price_usd: number | null }, rate: number) {
	return quote.price ?? (quote.price_usd == null ? null : quote.price_usd * rate);
}
const key = (card: string, language: string) => `${card}/${language}`;

/** Inject the connection: tests use an isolated in-memory database, never db.ts. */
export function getPriceData(db: Database, userId: string, rate: number, today = new Date().toISOString().slice(0, 10)) {
	const holdings = db.prepare(`SELECT c.id, c.name, c.set_name, c.image_uri, c.local_image_path,
		c.price_eur, c.price_eur_foil, c.price_usd, c.price_usd_foil,
		cc.id AS collection_id, cc.quantity, cc.foil, cc.purchase_price, cc.added_at,
		COALESCE(cc.language, 'en') AS language,
		cpl.price_eur AS local_eur, cpl.price_eur_foil AS local_eur_foil,
		cpl.price_usd AS local_usd, cpl.price_usd_foil AS local_usd_foil
		FROM collection_cards cc JOIN cards c ON c.id = cc.card_id
		LEFT JOIN card_prices_lang cpl ON cpl.card_id = cc.card_id AND cpl.language = COALESCE(cc.language, 'en')
		WHERE cc.user_id = ?`).all(userId) as Holding[];

	// Read each relevant series once. Re-running the distinct-day lookup for
	// every holding previously took ~5 seconds for 379 rows on production.
	const snapshots = db.prepare(`WITH series AS MATERIALIZED (
		SELECT card_id, COALESCE(language, 'en') AS language FROM collection_cards WHERE user_id = ?
		UNION SELECT card_id, 'en' FROM collection_cards WHERE user_id = ?
	) SELECT ph.card_id, ph.language, ph.snapshot_date,
		ph.price_eur, ph.price_eur_foil, ph.price_usd, ph.price_usd_foil
		FROM series s JOIN price_history ph ON ph.card_id = s.card_id AND ph.language = s.language
		WHERE ph.snapshot_date <= ? ORDER BY ph.card_id, ph.language, ph.snapshot_date`).all(userId, userId, today) as Snapshot[];
	const history = new Map<string, Snapshot[]>();
	for (const row of snapshots) {
		const id = key(row.card_id, row.language);
		const rows = history.get(id) ?? [];
		rows.push(row);
		history.set(id, rows);
	}
	const previous = new Map<string, Snapshot>();
	for (const [id, rows] of history) {
		const row = rows.findLast(r => r.snapshot_date < today);
		if (row) previous.set(id, row);
	}
	const topCards = holdings.map(h => {
		const current = prices(h, {
			price_eur: h.local_eur, price_eur_foil: h.local_eur_foil,
			price_usd: h.local_usd, price_usd_foil: h.local_usd_foil
		}, h.foil, h.language !== 'en');
		const prev = prices(previous.get(key(h.id, 'en')), previous.get(key(h.id, h.language)), h.foil, h.language !== 'en');
		return {
			id: h.id, collection_id: h.collection_id, name: h.name, set_name: h.set_name,
			image_uri: h.image_uri, local_image_path: h.local_image_path,
			quantity: h.quantity, foil: h.foil, language: h.language, purchase_price: h.purchase_price,
			...current, prev_price: prev.price, prev_price_usd: prev.price_usd, prev_estimated: prev.estimated
		};
	});
	const stats = { totalValue: 0, totalPurchaseValue: 0, profitValue: 0, profitCost: 0, profitCopies: 0,
		uniqueCards: new Set(holdings.map(h => h.id)).size, totalCards: 0 };
	let missingPriceCount = 0, missingMarketCount = 0, estimatedCount = 0;
	for (const h of topCards) {
		const value = inEur(h, rate);
		stats.totalCards += h.quantity;
		stats.totalValue += (value ?? 0) * h.quantity;
		stats.totalPurchaseValue += (h.purchase_price ?? 0) * h.quantity;
		if (h.purchase_price == null) missingPriceCount += h.quantity;
		if (value == null) missingMarketCount += h.quantity;
		if (h.estimated) estimatedCount += h.quantity;
		if (value != null && h.purchase_price != null) {
			stats.profitValue += value * h.quantity;
			stats.profitCost += h.purchase_price * h.quantity;
			stats.profitCopies += h.quantity;
		}
	}

	const eligible = holdings.map((h, i) => ({ h, current: topCards[i] })).filter(({ h }) => h.purchase_price != null);
	const days = new Set<string>();
	if (eligible.length) {
		days.add(today);
		const earliest = eligible.reduce((date, { h }) => {
			const owned = h.added_at?.slice(0, 10) ?? '1970-01-01';
			if (h.added_at && owned <= today) days.add(owned);
			return owned < date ? owned : date;
		}, today);
		const eligibleKeys = new Set(eligible.flatMap(({ h }) => [key(h.id, h.language), key(h.id, 'en')]));
		for (const row of snapshots) {
			if (eligibleKeys.has(key(row.card_id, row.language)) && row.snapshot_date >= earliest) days.add(row.snapshot_date);
		}
	}
	const currentSnapshots = new Map<string, Snapshot>();
	const cursors = new Map<string, number>();
	const profitHistory: ProfitPoint[] = [];
	for (const day of [...days].sort()) {
		for (const [id, rows] of history) {
			let index = cursors.get(id) ?? 0;
			while (index < rows.length && rows[index].snapshot_date <= day) currentSnapshots.set(id, rows[index++]);
			cursors.set(id, index);
		}
		let value = 0, cost = 0, priced = 0, missing = 0, estimated = 0;
		for (const { h, current } of eligible) {
			if (day !== today && day < (h.added_at?.slice(0, 10) ?? '1970-01-01')) continue;
			const quote = day === today ? current : prices(currentSnapshots.get(key(h.id, 'en')),
				currentSnapshots.get(key(h.id, h.language)), h.foil, h.language !== 'en');
			const unit = inEur(quote, rate);
			// Unknown values are gaps, never a fictitious 100% loss. Do not
			// backfill earlier dates with prices learned in the future.
			if (unit == null) { missing += h.quantity; continue; }
			priced += h.quantity;
			value += unit * h.quantity;
			cost += h.purchase_price! * h.quantity;
			if (quote.estimated) estimated += h.quantity;
		}
		profitHistory.push({ recorded_at: day, total_value: priced ? value : null, total_purchase: priced ? cost : null,
			missing_market_count: missing, estimated_count: estimated });
	}
	return { topCards: topCards.filter(h => inEur(h, rate) != null), stats, missingPriceCount, missingMarketCount,
		estimatedCount, profitHistory, usdToEur: rate };
}

export type PriceData = ReturnType<typeof getPriceData>;

export function getCardPriceHistory(db: Database, cardId: string, language: string) {
	const rows = db.prepare(`SELECT * FROM price_history
		WHERE card_id = ? AND language IN (?, 'en') ORDER BY snapshot_date`).all(cardId, language) as Snapshot[];
	const result = [];
	let base: Snapshot | undefined, local: Snapshot | undefined;
	for (let i = 0; i < rows.length;) {
		const day = rows[i].snapshot_date;
		while (i < rows.length && rows[i].snapshot_date === day) {
			const row = rows[i++];
			if (row.language === 'en') base = row;
			if (row.language === language) local = row;
		}
		const regular = prices(base, local, 0, language !== 'en');
		const foil = prices(base, local, 1, language !== 'en');
		result.push({ recorded_at: day, price_eur: regular.price, price_usd: regular.price_usd,
			price_eur_foil: foil.price, price_usd_foil: foil.price_usd, estimated: regular.estimated || foil.estimated });
	}
	return result;
}
