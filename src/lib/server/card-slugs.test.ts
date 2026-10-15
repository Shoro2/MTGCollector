import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { cardSlugIndex } from './card-slugs';

let db: Database.Database;
beforeEach(() => {
	db = new Database(':memory:');
	db.exec('CREATE TABLE cards (id TEXT PRIMARY KEY, oracle_id TEXT, name TEXT NOT NULL, layout TEXT)');
});
afterEach(() => db.close());
const add = (id: string, oracle: string | null, name: string, layout = 'normal') =>
	db.prepare('INSERT INTO cards VALUES (?, ?, ?, ?)').run(id, oracle, name, layout);

it('gives one slug per card, skipping art series and printings without an oracle id', () => {
	add('p1', 'aaaaaaaa-1', 'Storm Crow'); add('p2', 'aaaaaaaa-1', 'Storm Crow');
	add('p3', 'bbbbbbbb-2', 'Storm Crow', 'token');
	add('p4', 'cccccccc-3', 'Storm Crow // Storm Crow', 'art_series');
	add('p5', null, 'Reversible Thing', 'reversible_card');
	const index = cardSlugIndex(db);
	expect(index.slugs).toEqual(['storm-crow', 'storm-crow-bbbbbbbb']);
	expect(index.bySlug.get('storm-crow')).toBe('aaaaaaaa-1');
	expect(index.byOracle.has('cccccccc-3')).toBe(false);
});

it('picks up cards inserted after the first build', () => {
	add('p1', 'aaaaaaaa-1', 'Storm Crow');
	expect(cardSlugIndex(db).slugs).toEqual(['storm-crow']);
	add('p2', 'dddddddd-4', 'Lightning Bolt');
	expect(cardSlugIndex(db).bySlug.get('lightning-bolt')).toBe('dddddddd-4');
});
