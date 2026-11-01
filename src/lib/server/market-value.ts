import type { Database } from 'better-sqlite3';
import { SNAPSHOT_INDEX_SQL } from './admin-stats.js';

// The market value of every Magic card: one copy of every English printing at its
// price on each price-update day, summed per market (Cardmarket in euros, TCGplayer
// in US dollars). A printing counts with its non-foil price, or its foil price when
// it only exists in foil (as displayPrice() shows it).
//
// price_history is change-only (a row only when a printing's price changed), so a
// day's total is the sum over every printing of its latest row up to that day.
// Summing that at request time would walk millions of rows; instead one row per
// day is kept in market_value_daily: rebuilt from the whole history once, then
// extended by the day's own rows after every price update. The connection is
// injected, so tests use an in-memory database and never db.ts.

export const MARKET_VALUE_SQL = `
CREATE TABLE IF NOT EXISTS market_value_daily (
	snapshot_date TEXT PRIMARY KEY,
	eur REAL NOT NULL,
	eur_printings INTEGER NOT NULL,
	eur_moved REAL NOT NULL,
	usd REAL NOT NULL,
	usd_printings INTEGER NOT NULL,
	usd_moved REAL NOT NULL
) WITHOUT ROWID`;

/** Migration 0034: the same sums per set. */
export const MARKET_VALUE_SET_SQL = `
CREATE TABLE IF NOT EXISTS market_value_set_daily (
	set_code TEXT NOT NULL,
	snapshot_date TEXT NOT NULL,
	eur REAL NOT NULL,
	eur_printings INTEGER NOT NULL,
	eur_moved REAL NOT NULL,
	usd REAL NOT NULL,
	usd_printings INTEGER NOT NULL,
	usd_moved REAL NOT NULL,
	PRIMARY KEY (set_code, snapshot_date)
) WITHOUT ROWID`;

// market_value_set_daily holds the same sums per set (cards.set_code; '' for a
// printing without a cards row, so the sets add up to the whole market). A set has
// a row only on the update days on which one of its printings got a price row; on
// the days between, it kept its value and nothing moved (marketValueSetHistory()
// carries it forward).

/** One day of the market: totals, priced printings and the like-for-like move since the update before. */
export type MarketValueDay = {
	snapshot_date: string;
	/** Sum over every printing with a Cardmarket price. */
	eur: number;
	eur_printings: number;
	/** Price changes of the printings that had a Cardmarket price on this day and the update before. */
	eur_moved: number;
	usd: number;
	usd_printings: number;
	usd_moved: number;
};

type PriceRow = [string, number | null, number | null, number | null, number | null];

/** One copy of a printing in one market: non-foil, else foil. */
const unit = (normal: number | null, foil: number | null) => normal ?? foil ?? null;

/** Running totals of one market while the history is walked. */
class Market {
	total = 0;
	printings = 0;
	moved = 0;
	/** Apply a printing's new price; `before` is its price until this day (null: none). */
	apply(before: number | null, after: number | null) {
		if (before != null) { this.total -= before; this.printings--; }
		if (after != null) { this.total += after; this.printings++; }
		if (before != null && after != null) this.moved += after - before;
	}
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** Both markets of one set while a day is walked; `touched`: one of its printings had a row that day. */
type SetMarkets = { eur: Market; usd: Market; touched: boolean };
const setMarkets = (): SetMarkets => ({ eur: new Market(), usd: new Market(), touched: false });

/** One stored day of one set. */
export type MarketValueSetDay = MarketValueDay & { set_code: string };

function dayRow(date: string, eur: Market, usd: Market): MarketValueDay {
	return {
		snapshot_date: date,
		eur: cents(eur.total), eur_printings: eur.printings, eur_moved: cents(eur.moved),
		usd: cents(usd.total), usd_printings: usd.printings, usd_moved: cents(usd.moved)
	};
}

function writer(db: Database) {
	const stmt = db.prepare(`INSERT INTO market_value_daily
		(snapshot_date, eur, eur_printings, eur_moved, usd, usd_printings, usd_moved)
		VALUES (@snapshot_date, @eur, @eur_printings, @eur_moved, @usd, @usd_printings, @usd_moved)
		ON CONFLICT(snapshot_date) DO UPDATE SET eur = excluded.eur, eur_printings = excluded.eur_printings,
			eur_moved = excluded.eur_moved, usd = excluded.usd, usd_printings = excluded.usd_printings,
			usd_moved = excluded.usd_moved`);
	return (row: MarketValueDay) => stmt.run(row);
}

function setWriter(db: Database) {
	const stmt = db.prepare(`INSERT INTO market_value_set_daily
		(set_code, snapshot_date, eur, eur_printings, eur_moved, usd, usd_printings, usd_moved)
		VALUES (@set_code, @snapshot_date, @eur, @eur_printings, @eur_moved, @usd, @usd_printings, @usd_moved)
		ON CONFLICT(set_code, snapshot_date) DO UPDATE SET eur = excluded.eur, eur_printings = excluded.eur_printings,
			eur_moved = excluded.eur_moved, usd = excluded.usd, usd_printings = excluded.usd_printings,
			usd_moved = excluded.usd_moved`);
	return (row: MarketValueSetDay) => stmt.run(row);
}

/** The rows of the sets touched on `date`; resets their daily move. */
function touchedSetRows(date: string, sets: Map<string, SetMarkets>): MarketValueSetDay[] {
	const rows: MarketValueSetDay[] = [];
	for (const [code, markets] of sets) {
		if (!markets.touched) continue;
		rows.push({ set_code: code, ...dayRow(date, markets.eur, markets.usd) });
		markets.touched = false;
		markets.eur.moved = 0;
		markets.usd.moved = 0;
	}
	return rows;
}

/** Set code of every printing in the catalogue ('' for none). */
function setCodes(db: Database): Map<string, string> {
	const rows = db.prepare('SELECT id, set_code FROM cards').raw().all() as Array<[string, string | null]>;
	return new Map(rows.map(([id, code]) => [id, code ?? '']));
}

/**
 * Recompute every day from the whole English price history. The rows are read in
 * date order through idx_price_history_snapshot_card: a day's rows were written by
 * one update, so they sit together in the table and the lookups stay close to a
 * sequential read. Memory: the current price of each printing, not the history.
 */
export function rebuildMarketValue(db: Database): { days: number; rows: number } {
	db.exec(SNAPSHOT_INDEX_SQL); // migration 0023; a no-op on every migrated database
	const prices = new Map<string, [number | null, number | null]>();
	const eur = new Market();
	const usd = new Market();
	const days: MarketValueDay[] = [];
	const setOf = setCodes(db);
	const sets = new Map<string, SetMarkets>();
	const setDays: MarketValueSetDay[] = [];
	let date: string | null = null;
	let rows = 0;
	const rowsInOrder = db.prepare(`SELECT snapshot_date, card_id, price_eur, price_eur_foil, price_usd, price_usd_foil
		FROM price_history INDEXED BY idx_price_history_snapshot_card
		WHERE snapshot_date IS NOT NULL AND language = 'en'
		ORDER BY snapshot_date ASC, card_id DESC`).raw();
	for (const raw of rowsInOrder.iterate() as IterableIterator<[string, ...PriceRow]>) {
		const [day, id, pEur, pEurFoil, pUsd, pUsdFoil] = raw;
		if (day !== date) {
			if (date != null) { days.push(dayRow(date, eur, usd)); setDays.push(...touchedSetRows(date, sets)); }
			date = day;
			eur.moved = 0;
			usd.moved = 0;
		}
		const before = prices.get(id);
		const after: [number | null, number | null] = [unit(pEur, pEurFoil), unit(pUsd, pUsdFoil)];
		eur.apply(before?.[0] ?? null, after[0]);
		usd.apply(before?.[1] ?? null, after[1]);
		const code = setOf.get(id) ?? '';
		let set = sets.get(code);
		if (!set) sets.set(code, set = setMarkets());
		set.eur.apply(before?.[0] ?? null, after[0]);
		set.usd.apply(before?.[1] ?? null, after[1]);
		set.touched = true;
		prices.set(id, after);
		rows++;
	}
	if (date != null) { days.push(dayRow(date, eur, usd)); setDays.push(...touchedSetRows(date, sets)); }
	// The first day has no update before it: nothing moved, every printing was new.
	// (A set's own first day needs no such rule: its printings had no price before.)
	if (days.length) { days[0].eur_moved = 0; days[0].usd_moved = 0; }

	const write = writer(db);
	const writeSet = setWriter(db);
	db.transaction(() => {
		db.exec('DELETE FROM market_value_daily');
		db.exec('DELETE FROM market_value_set_daily');
		for (const day of days) write(day);
		for (const day of setDays) writeSet(day);
	})();
	return { days: days.length, rows };
}

/**
 * One day from the day before it: its English rows against each printing's row
 * before that day (the same pairing as the homepage's price moves). The sets the
 * day touched are written from each set's latest stored row before that day.
 */
function extendDay(db: Database, date: string, base: MarketValueDay): { day: MarketValueDay; sets: MarketValueSetDay[] } {
	const eur = new Market(); eur.total = base.eur; eur.printings = base.eur_printings;
	const usd = new Market(); usd.total = base.usd; usd.printings = base.usd_printings;
	// Each set's latest row before the day (SQLite takes the bare columns from the MAX row).
	const before = db.prepare(`SELECT set_code, eur, eur_printings, usd, usd_printings, MAX(snapshot_date)
		FROM market_value_set_daily WHERE snapshot_date < ? GROUP BY set_code`).all(date) as MarketValueSetDay[];
	const sets = new Map<string, SetMarkets>();
	for (const row of before) {
		const markets = setMarkets();
		markets.eur.total = row.eur; markets.eur.printings = row.eur_printings;
		markets.usd.total = row.usd; markets.usd.printings = row.usd_printings;
		sets.set(row.set_code, markets);
	}
	const rows = db.prepare(`SELECT COALESCE(c.set_code, ''), t.price_eur, t.price_eur_foil, t.price_usd, t.price_usd_foil,
			p.price_eur, p.price_eur_foil, p.price_usd, p.price_usd_foil
		FROM price_history t
		LEFT JOIN cards c ON c.id = t.card_id
		LEFT JOIN price_history p ON p.rowid = (SELECT q.rowid FROM price_history q
			WHERE q.card_id = t.card_id AND q.language = 'en' AND q.snapshot_date < t.snapshot_date
			ORDER BY q.snapshot_date DESC LIMIT 1)
		WHERE t.snapshot_date = ? AND t.language = 'en'`).raw().all(date) as Array<[string, ...Array<number | null>]>;
	for (const [code, eNow, efNow, uNow, ufNow, ePrev, efPrev, uPrev, ufPrev] of rows) {
		const was = [unit(ePrev, efPrev), unit(uPrev, ufPrev)], now = [unit(eNow, efNow), unit(uNow, ufNow)];
		eur.apply(was[0], now[0]);
		usd.apply(was[1], now[1]);
		let set = sets.get(code);
		if (!set) sets.set(code, set = setMarkets());
		set.eur.apply(was[0], now[0]);
		set.usd.apply(was[1], now[1]);
		set.touched = true;
	}
	return { day: dayRow(date, eur, usd), sets: touchedSetRows(date, sets) };
}

/** English price-update days of the history from `from` on. */
function historyDates(db: Database, from: string): string[] {
	return db.prepare(`SELECT DISTINCT snapshot_date FROM price_history
		WHERE snapshot_date >= ? AND language = 'en' ORDER BY snapshot_date`).pluck().all(from) as string[];
}

const EMPTY_DAY: MarketValueDay = { snapshot_date: '', eur: 0, eur_printings: 0, eur_moved: 0, usd: 0, usd_printings: 0, usd_moved: 0 };

/**
 * Bring market_value_daily up to the price history after a price update. The
 * latest stored day is computed again (a second price run on one day changes its
 * rows) and every later day is added from the one before it. When the stored days
 * do not line up with the history (an empty table, a day written into the past by
 * `npm run backfill-prices`), everything is rebuilt. Returns the days written.
 */
export function updateMarketValue(db: Database): { mode: 'extended' | 'rebuilt'; days: number } {
	const latest = db.prepare('SELECT MAX(snapshot_date) FROM market_value_daily').pluck().get() as string | null;
	const pending = latest ? historyDates(db, latest) : [];
	// The per-set table must end on the same day (it is empty after migration 0034).
	const setsLatest = db.prepare('SELECT MAX(snapshot_date) FROM market_value_set_daily').pluck().get() as string | null;
	if (!latest || pending[0] !== latest || setsLatest !== latest) return { mode: 'rebuilt', days: rebuildMarketValue(db).days };

	const storedBefore = db.prepare('SELECT * FROM market_value_daily WHERE snapshot_date < ? ORDER BY snapshot_date DESC LIMIT 1');
	const historyBefore = db.prepare(`SELECT MAX(snapshot_date) FROM price_history
		WHERE snapshot_date < ? AND language = 'en'`).pluck();
	const write = writer(db);
	const writeSet = setWriter(db);
	const dropSets = db.prepare('DELETE FROM market_value_set_daily WHERE snapshot_date = ?');
	const lined = db.transaction(() => {
		for (const date of pending) {
			const base = storedBefore.get(date) as MarketValueDay | undefined;
			const expected = historyBefore.get(date) as string | null;
			// The stored day before must be the history's day before, or the base is wrong.
			if ((base?.snapshot_date ?? null) !== expected) return false;
			const { day, sets } = extendDay(db, date, base ?? EMPTY_DAY);
			write(day);
			dropSets.run(date); // the latest day again: a set the second run no longer touches loses its row
			for (const set of sets) writeSet(set);
		}
		return true;
	})();
	if (!lined) return { mode: 'rebuilt', days: rebuildMarketValue(db).days };
	return { mode: 'extended', days: pending.length };
}

/** Stored days from `from` (YYYY-MM-DD) on, oldest first. */
export function marketValueHistory(db: Database, from: string): MarketValueDay[] {
	return db.prepare('SELECT * FROM market_value_daily WHERE snapshot_date >= ? ORDER BY snapshot_date').all(from) as MarketValueDay[];
}

/**
 * One set's days from `from` on, oldest first, one per price-update day from the
 * set's first price on: a day on which none of its printings changed carries the
 * set's value forward with nothing moved. The set's first day (its release) moved
 * nothing, because its printings had no price before.
 */
export function marketValueSetHistory(db: Database, setCode: string, from: string): MarketValueDay[] {
	const rows = db.prepare(`SELECT snapshot_date, eur, eur_printings, eur_moved, usd, usd_printings, usd_moved
		FROM market_value_set_daily WHERE set_code = ? ORDER BY snapshot_date`).all(setCode) as MarketValueDay[];
	if (!rows.length) return [];
	const dates = db.prepare('SELECT snapshot_date FROM market_value_daily WHERE snapshot_date >= ? ORDER BY snapshot_date')
		.pluck().all(rows[0].snapshot_date) as string[];
	const out: MarketValueDay[] = [];
	let i = 0, current = rows[0];
	for (const date of dates) {
		while (i < rows.length && rows[i].snapshot_date <= date) current = rows[i++];
		const day = current.snapshot_date === date ? current : { ...current, snapshot_date: date, eur_moved: 0, usd_moved: 0 };
		if (date >= from) out.push(day);
	}
	return out;
}

/** The sets that have a stored day, by name: what the set filter offers. */
export function marketValueSets(db: Database): Array<{ code: string; name: string }> {
	return db.prepare(`SELECT c.set_code AS code, MAX(c.set_name) AS name FROM cards c
		WHERE c.set_code IN (SELECT DISTINCT set_code FROM market_value_set_daily WHERE set_code != '')
		GROUP BY c.set_code ORDER BY MAX(c.set_name) COLLATE NOCASE, c.set_code`).all() as Array<{ code: string; name: string }>;
}
