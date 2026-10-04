import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { sitemapIndex, sitemapPart, SITEMAP_PAGE_SIZE } from './sitemap';

let db: Database.Database;
beforeEach(() => {
	db = new Database(':memory:');
	db.exec('CREATE TABLE cards (id TEXT PRIMARY KEY)');
});
afterEach(() => db.close());
const locations = (xml: string) => [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]);

it('covers a catalogue larger than the 50,000-URL limit exactly once in bounded parts', () => {
	const insert = db.prepare('INSERT INTO cards VALUES (?)');
	db.transaction(() => {
		for (let i = 0; i < 50_001; i++) insert.run(String(i).padStart(6, '0'));
	})();
	const parts = locations(sitemapIndex(db)).filter(url => url.includes('cards-'));
	expect(parts).toHaveLength(6);
	const all: string[] = [];
	for (const url of parts) {
		const part = /sitemap-(cards-\d+)\.xml$/.exec(url)![1];
		const xml = sitemapPart(db, part)!;
		const urls = locations(xml);
		expect(urls.length).toBeLessThanOrEqual(SITEMAP_PAGE_SIZE);
		expect(Buffer.byteLength(xml)).toBeLessThan(50 * 1024 * 1024);
		all.push(...urls);
	}
	expect(all).toHaveLength(50_001);
	expect(new Set(all).size).toBe(50_001);
	expect(all[0]).toMatch(/\/000000$/);
	expect(all.at(-1)).toMatch(/\/050000$/);
});

it('keeps private pages out and works for an empty catalogue', () => {
	expect(locations(sitemapIndex(db))).toEqual(['https://mtg-collector.com/sitemap-pages.xml']);
	expect(locations(sitemapPart(db, 'pages')!)).toEqual([
		'https://mtg-collector.com/', 'https://mtg-collector.com/cards', 'https://mtg-collector.com/scan',
		'https://mtg-collector.com/contact', 'https://mtg-collector.com/impressum', 'https://mtg-collector.com/datenschutz'
	]);
	expect(sitemapPart(db, 'cards-1')).toBeNull();
});

it.each(['cards-0', 'cards--1', 'cards-01', 'cards-1.5', 'cards-99999999999999999999', 'cards-2', 'admin'])('rejects invalid or absent part %s', part => {
	db.prepare('INSERT INTO cards VALUES (?)').run('one');
	expect(sitemapPart(db, part)).toBeNull();
});
