import { expect, it } from 'vitest';
import { sitemapIndex, sitemapPart, SITEMAP_PAGE_SIZE } from './sitemap';

const locations = (xml: string) => [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]);

it('covers a catalogue larger than the 50,000-URL limit exactly once in bounded parts', () => {
	const slugs = Array.from({ length: 50_001 }, (_, i) => `card-${String(i).padStart(6, '0')}`);
	const parts = locations(sitemapIndex(slugs)).filter(url => url.includes('cards-'));
	expect(parts).toHaveLength(6);
	const all: string[] = [];
	for (const url of parts) {
		const part = /sitemap-(cards-\d+)\.xml$/.exec(url)![1];
		const xml = sitemapPart(slugs, part)!;
		const urls = locations(xml);
		expect(urls.length).toBeLessThanOrEqual(SITEMAP_PAGE_SIZE);
		expect(Buffer.byteLength(xml)).toBeLessThan(50 * 1024 * 1024);
		all.push(...urls);
	}
	expect(all).toHaveLength(50_001);
	expect(new Set(all).size).toBe(50_001);
	expect(all[0]).toBe('https://mtg-collector.com/cards/card-000000');
	expect(all.at(-1)).toBe('https://mtg-collector.com/cards/card-050000');
});

it('keeps private pages out and works for an empty catalogue', () => {
	expect(locations(sitemapIndex([]))).toEqual(['https://mtg-collector.com/sitemap-pages.xml']);
	expect(locations(sitemapPart([], 'pages')!)).toEqual([
		'https://mtg-collector.com/', 'https://mtg-collector.com/cards', 'https://mtg-collector.com/decks', 'https://mtg-collector.com/scan',
		'https://mtg-collector.com/portfolio-tracker', 'https://mtg-collector.com/contact', 'https://mtg-collector.com/impressum', 'https://mtg-collector.com/datenschutz'
	]);
	expect(sitemapPart([], 'cards-1')).toBeNull();
});

it.each(['cards-0', 'cards--1', 'cards-01', 'cards-1.5', 'cards-99999999999999999999', 'cards-2', 'admin'])('rejects invalid or absent part %s', part => {
	expect(sitemapPart(['one'], part)).toBeNull();
});

it('lists card pages, never printing ids', () => {
	expect(locations(sitemapPart(['teferis-protection', 'storm-crow'], 'cards-1')!)).toEqual([
		'https://mtg-collector.com/cards/teferis-protection', 'https://mtg-collector.com/cards/storm-crow'
	]);
});

it('lists indexable decks in their own parts, with the date of their last change', () => {
	const decks = [{ id: 'AbCdEfGhIjKlMn_-', updated_at: '2026-10-29T21:00:00.000Z' }];
	expect(locations(sitemapIndex(['one'], decks))).toEqual([
		'https://mtg-collector.com/sitemap-pages.xml', 'https://mtg-collector.com/sitemap-cards-1.xml', 'https://mtg-collector.com/sitemap-decks-1.xml'
	]);
	const xml = sitemapPart(['one'], 'decks-1', decks)!;
	expect(xml).toContain('<url><loc>https://mtg-collector.com/decks/AbCdEfGhIjKlMn_-</loc><lastmod>2026-10-29T21:00:00.000Z</lastmod></url>');
	expect(sitemapPart(['one'], 'decks-2', decks)).toBeNull();
	expect(sitemapPart(['one'], 'decks-1', [])).toBeNull();
	expect(locations(sitemapIndex(['one'], []))).not.toContain('https://mtg-collector.com/sitemap-decks-1.xml');
	expect(sitemapPart(['one'], 'cards-1', decks)).not.toContain('<lastmod>');
});
