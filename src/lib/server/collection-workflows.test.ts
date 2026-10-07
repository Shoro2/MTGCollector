import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema-sql';
import { bulkEditCollection, collectionLocations, moveCollectionCopies } from './collection-actions';
import { parseCollectionImport, readCsv } from '../collection-import';
import { commitCollectionImport, prepareCollectionImport } from './collection-import';

const options = { currency: 'EUR', location: '', ignorePrices: false };
function fixture() {
	const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(SCHEMA_SQL);
	db.exec(`CREATE TABLE card_names(name TEXT, lang TEXT, printed_name TEXT);
		INSERT INTO card_names VALUES ('War Horn','de','Kriegshorn');
		INSERT INTO users(id,google_id,email,name) VALUES ('a','a','a@example.invalid','A'),('b','b','b@example.invalid','B');
		INSERT INTO cards(id,name,set_code,set_name,collector_number) VALUES
		('horn','War Horn','ori','Magic Origins','243'),('horn-alt','War Horn','ori','Magic Origins','243p'),
		('new-horn','War Horn','new','New Set','9');
		INSERT INTO collection_cards(id,user_id,card_id,quantity,condition,foil,language,purchase_price,location,notes,added_at) VALUES
		(1,'a','horn',4,'near_mint',0,'de',2,'Box A','Keep me','2026-01-01T00:00:00.000Z'),
		(2,'b','horn',7,'near_mint',0,'en',3,'Private box',NULL,'2026-02-01T00:00:00.000Z');
		INSERT INTO tags(id,user_id,name) VALUES (1,'a','Favorites');
		INSERT INTO collection_card_tags VALUES(1,1);`);
	return db;
}
const parse = (text: string) => parseCollectionImport(text, 'csv', options);

describe('collection locations and atomic edits', () => {
	it('splits copies without changing value, dates or tags', () => {
		const db = fixture();
		moveCollectionCopies(db, 'a', 1, 2, 'Box B');
		const rows = db.prepare("SELECT * FROM collection_cards WHERE user_id='a' ORDER BY id").all() as Record<string, unknown>[];
		expect(rows.map(r => [r.quantity, r.location, r.purchase_price, r.added_at, r.notes])).toEqual([
			[2, 'Box A', 2, '2026-01-01T00:00:00.000Z', 'Keep me'], [2, 'Box B', 2, '2026-01-01T00:00:00.000Z', 'Keep me']]);
		expect(db.prepare('SELECT COUNT(*) AS n FROM collection_card_tags').get()).toEqual({ n: 2 });
		expect(collectionLocations(db, 'a')).toEqual(['Box A', 'Box B']); db.close();
	});
	it('checks every owner before editing and rejects oversized moves', () => {
		const db = fixture();
		expect(() => bulkEditCollection(db, 'a', [1, 2], { location: 'Oops' })).toThrow('no longer available');
		expect(() => moveCollectionCopies(db, 'a', 2, 1, 'Oops')).toThrow('no longer available');
		expect(() => moveCollectionCopies(db, 'a', 1, 5, 'Oops')).toThrow('more copies');
		expect(collectionLocations(db, 'a')).toEqual(['Box A']); db.close();
	});
	it('edits only supplied fields and preserves distinct purchase lots', () => {
		const db = fixture();
		bulkEditCollection(db, 'a', [1, 1], { location: '', condition: 'lightly_played', language: 'en', foil: true });
		expect(db.prepare('SELECT location,condition,language,foil,quantity,purchase_price FROM collection_cards WHERE id=1').get())
			.toEqual({ location: '', condition: 'lightly_played', language: 'en', foil: 1, quantity: 4, purchase_price: 2 });
		expect(() => bulkEditCollection(db, 'a', [1], { language: 'oops' })).toThrow('Invalid language');
		expect(() => bulkEditCollection(db, 'a', [1], { user_id: 'b' })).toThrow('at least one'); db.close();
	});
});

describe('collection CSV and text imports', () => {
	it('reads quoted multiline fields, BOM, semicolons and escaped quotes', () => {
		expect(readCsv('\uFEFFName;Notes\r\nWar Horn;"a; b\r\n""quoted"""')).toEqual([['Name', 'Notes'], ['War Horn', 'a; b\n"quoted"']]);
		expect(() => readCsv('Name,Notes\nx,"unfinished')).toThrow('unclosed');
	});
	it('maps ManaBox export columns including zero costs and German names', () => {
		const db = fixture();
		const parsed = parse('Name,Set code,Collector number,Foil,Quantity,Scryfall ID,Purchase price,Purchase price currency,Condition,Language,Binder Name\nKriegshorn,ori,0243,normal,2,,0,EUR,NM,German,Trading');
		const plan = prepareCollectionImport(db, 'a', parsed, 'append');
		expect(plan.summary).toMatchObject({ ready: 1, copies: 2, issues: 0 });
		expect(plan.ready[0]).toMatchObject({ purchasePrice: 0, location: 'Trading', language: 'de', card: { id: 'horn' } }); db.close();
	});
	it('maps Dragon Shield columns and keeps folders and purchase dates', () => {
		const parsed = parse('Folder Name,Quantity,Card Name,Set Code,Card Number,Condition,Printing,Language,Price Bought,Date Bought\nBox C,1,War Horn,ori,243,NM,Normal,English,1.25,2026-01-02');
		expect(parsed.entries[0]).toMatchObject({ location: 'Box C', purchasePrice: 1.25, foil: 0, addedAt: '2026-01-02T00:00:00.000Z' });
		expect(parsed.issues).toEqual([]);
	});
	it('supports configurable Delver columns through explicit mapping', () => {
		const parsed = parseCollectionImport('Card;Edition Code;Collector Number;Amount;Acquired Price\nWar Horn;ori;243;3;"1,50"', 'csv', {
			...options, mapping: { name: 'Card', set: 'Edition Code', number: 'Collector Number', quantity: 'Amount', price: 'Acquired Price' }
		});
		expect(parsed.entries[0]).toMatchObject({ name: 'War Horn', set: 'ori', number: '243', quantity: 3, purchasePrice: 1.5 });
	});
	it('rejects unsupported finishes, invalid quantities, currencies and dates visibly', () => {
		for (const [column, value] of [['Foil','etched'], ['Quantity','-1'], ['Date Added','2026-02-31'], ['Language','mystery']]) {
			expect(parse(`Name,Set Code,Collector Number,${column}\nWar Horn,ori,243,${value}`).issues).toHaveLength(1);
		}
		expect(parse('Name,Set Code,Purchase Price,Purchase Price Currency\nWar Horn,ori,5,USD').issues[0].message).toContain('USD');
	});
	it('never substitutes a newer printing when the specified edition is missing or ambiguous', () => {
		const db = fixture();
		const plan = prepareCollectionImport(db, 'a', parse('Name,Set Code,Collector Number\nWar Horn,missing,243\nWar Horn,ori,\nWar Horn,ori,243p'), 'append');
		expect(plan.issues).toHaveLength(2);
		expect(plan.ready.map(r => r.card.id)).toEqual(['horn-alt']); db.close();
	});
	it('rejects contradictory IDs and supports exact name/set resolution', () => {
		const db = fixture();
		const plan = prepareCollectionImport(db, 'a', parse('Scryfall ID,Name,Set Name,Collector Number\nhorn,War Horn,New Set,9\n,War Horn,New Set,'), 'append');
		expect(plan.issues).toHaveLength(1); expect(plan.ready[0].card.id).toBe('new-horn'); db.close();
	});
	it('previews without writing and rejects a stale confirmation', () => {
		const db = fixture(), parsed = parse('Name,Set Code,Collector Number\nWar Horn,new,9');
		const plan = prepareCollectionImport(db, 'a', parsed, 'append');
		expect(db.prepare('SELECT COUNT(*) AS n FROM collection_cards').get()).toEqual({ n: 2 });
		db.prepare('UPDATE collection_cards SET quantity=3 WHERE id=1').run();
		expect(() => commitCollectionImport(db, 'a', parsed, 'append', plan.digest, false)).toThrow('changed'); db.close();
	});
	it('keeps other users isolated and distinguishes locations and acquisition costs', () => {
		const db = fixture();
		const parsed = parse('Name,Set Code,Collector Number,Language,Location,Purchase Price\nWar Horn,ori,243,German,Box A,2\nWar Horn,ori,243,German,Box B,2\nWar Horn,ori,243,German,Box A,4');
		const plan = prepareCollectionImport(db, 'a', parsed, 'merge');
		expect(plan.summary).toMatchObject({ ready: 2, skipped: 1 });
		commitCollectionImport(db, 'a', parsed, 'merge', plan.digest, false);
		expect(db.prepare("SELECT SUM(quantity) AS n FROM collection_cards WHERE user_id='b'").get()).toEqual({ n: 7 }); db.close();
	});
	it('rejects replacement after tag assignments changed since preview', () => {
		const db = fixture(), parsed = parse('Name,Set Code,Collector Number\nWar Horn,ori,243');
		const plan = prepareCollectionImport(db, 'a', parsed, 'sync');
		db.prepare('DELETE FROM collection_card_tags WHERE collection_card_id=1').run();
		expect(() => commitCollectionImport(db, 'a', parsed, 'sync', plan.digest, true)).toThrow('changed');
		expect(db.prepare("SELECT quantity FROM collection_cards WHERE user_id='a'").get()).toEqual({ quantity: 4 }); db.close();
	});
	it('blocks incomplete replacement and requires explicit replacement confirmation', () => {
		const db = fixture(), parsed = parse('Name,Set Code,Collector Number\nWar Horn,missing,1\nWar Horn,new,9');
		const plan = prepareCollectionImport(db, 'a', parsed, 'sync');
		expect(() => commitCollectionImport(db, 'a', parsed, 'sync', plan.digest, true)).toThrow('without unresolved');
		const clean = parse('Name,Set Code,Collector Number\nWar Horn,new,9');
		const cleanPlan = prepareCollectionImport(db, 'a', clean, 'sync');
		expect(() => commitCollectionImport(db, 'a', clean, 'sync', cleanPlan.digest, false)).toThrow('explicit');
		expect(collectionLocations(db, 'a')).toEqual(['Box A']); db.close();
	});
	it('preserves exported dates, notes, locations and delimiter-containing tags', () => {
		const db = fixture();
		const columns = ['Scryfall ID','Quantity','Language','Location','Purchase Price','Date Added','Notes','Tags JSON'];
		const values = ['horn','2','de','Box A','2','2026-01-01T00:00:00.000Z','Line one\nLine two',JSON.stringify(['Red; Blue','One, Two'])];
		const parsed = parse(columns.join(',') + '\n' + values.map(v => `"${v.replaceAll('"','""')}"`).join(','));
		const plan = prepareCollectionImport(db, 'a', parsed, 'sync');
		commitCollectionImport(db, 'a', parsed, 'sync', plan.digest, true);
		expect(db.prepare("SELECT notes,location,added_at FROM collection_cards WHERE user_id='a'").get())
			.toEqual({ notes: 'Line one\nLine two', location: 'Box A', added_at: '2026-01-01T00:00:00.000Z' });
		expect(db.prepare("SELECT name FROM tags WHERE name IN ('Red; Blue','One, Two') ORDER BY name").all()).toEqual([{name:'One, Two'}, {name:'Red; Blue'}]); db.close();
	});
	it('keeps Moxfield text input and reports malformed lines', () => {
		const parsed = parseCollectionImport('2 War Horn (ORI) 243 *F*\nbad line', 'text', options);
		expect(parsed.entries[0]).toMatchObject({ quantity: 2, foil: 1, set: 'ori', number: '243' });
		expect(parsed.issues).toHaveLength(1);
	});
});
