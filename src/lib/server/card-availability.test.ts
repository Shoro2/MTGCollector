import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { availabilityWriter, ensureAvailabilityColumn, paperAvailability, SCANNABLE_CARD } from './card-availability';

describe('physical scanner availability', () => {
	it('uses explicit games metadata and preserves unknown metadata', () => {
		expect(paperAvailability({ games: ['paper', 'mtgo'] })).toBe(1);
		expect(paperAvailability({ games: ['mtgo'] })).toBe(0);
		expect(paperAvailability({ games: [] })).toBe(0);
		expect(paperAvailability({})).toBeNull();
		expect(paperAvailability({ games: 'paper' })).toBeNull();
	});
	it('migrates an existing catalogue idempotently and only changes known availability', () => {
		const db = new Database(':memory:');
		try {
			db.exec("CREATE TABLE cards(id TEXT PRIMARY KEY, layout TEXT, price_eur REAL); INSERT INTO cards VALUES ('ice','normal',20), ('me1','normal',1), ('unknown','normal',NULL), ('art','art_series',1)");
			ensureAvailabilityColumn(db); ensureAvailabilityColumn(db);
			const write = availabilityWriter(db);
			expect(write({ id: 'ice', games: ['paper', 'mtgo'] })).toBe(1);
			expect(write({ id: 'me1', games: ['mtgo'] })).toBe(1);
			expect(write({ id: 'me1', games: ['mtgo'] })).toBe(0);
			expect(write({ id: 'me1' })).toBe(0);
			expect(write({ id: 'absent', games: ['paper'] })).toBe(0);
			expect(db.prepare(`SELECT id FROM cards WHERE ${SCANNABLE_CARD} ORDER BY id`).all()).toEqual([{ id: 'ice' }, { id: 'unknown' }]);
			expect(db.prepare('SELECT price_eur FROM cards WHERE id=?').get('ice')).toEqual({ price_eur: 20 });
			expect(db.prepare('SELECT COUNT(*) AS count FROM cards').get()).toEqual({ count: 4 });
		} finally { db.close(); }
	});
});
