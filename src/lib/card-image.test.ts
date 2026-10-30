import { describe, expect, it } from 'vitest';
import {
	cardImageSrc,
	cardImageSrcset,
	cardPlaceholder,
	parseScryfallImage,
	placeholderName,
	scryfallImageAtSize,
	wrapName
} from './card-image';

const ID = '7a79190f-de60-4eb6-b925-594eb76ca8c3';
const URI = `https://cards.scryfall.io/normal/front/7/a/${ID}.jpg?1774980244`;

describe('parseScryfallImage', () => {
	it('reads size, side, id and version', () => {
		expect(parseScryfallImage(URI)).toEqual({ size: 'normal', side: 'front', id: ID, version: '1774980244' });
		expect(parseScryfallImage(URI.replace('/front/', '/back/').replace('?1774980244', ''))).toEqual({
			size: 'normal', side: 'back', id: ID, version: null
		});
	});

	it('refuses other hosts, paths and ids that do not match their folders', () => {
		expect(parseScryfallImage(null)).toBeNull();
		expect(parseScryfallImage('/favicon.ico')).toBeNull();
		expect(parseScryfallImage('https://c1.scryfall.com/file/x.jpg')).toBeNull();
		expect(parseScryfallImage(URI.replace('/7/a/', '/0/0/'))).toBeNull();
		expect(parseScryfallImage(URI.replace('cards.scryfall.io', 'evil.example'))).toBeNull();
		expect(parseScryfallImage(URI.replace('/normal/', '/png/'))).toBeNull();
		expect(parseScryfallImage(`${URI}&x=1`)).toBeNull();
	});

	it('rebuilds the URL at another size', () => {
		expect(scryfallImageAtSize(parseScryfallImage(URI)!, 'large')).toBe(URI.replace('/normal/', '/large/'));
	});
});

describe('cardImageSrc', () => {
	it('points Scryfall images at this host with the version as cache key', () => {
		expect(cardImageSrc(URI)).toBe(`/card-image/normal/front/${ID}.jpg?v=1774980244`);
		expect(cardImageSrc(URI, 'small')).toBe(`/card-image/small/front/${ID}.jpg?v=1774980244`);
	});

	it('passes other sources through and turns nothing into an empty string', () => {
		expect(cardImageSrc('/card-images/abc/1.jpg')).toBe('/card-images/abc/1.jpg');
		expect(cardImageSrc('blob:https://mtg-collector.com/1')).toBe('blob:https://mtg-collector.com/1');
		expect(cardImageSrc(null)).toBe('');
	});

	it('builds a srcset of the three sizes', () => {
		expect(cardImageSrcset(URI)).toBe(
			`/card-image/small/front/${ID}.jpg?v=1774980244 146w, /card-image/normal/front/${ID}.jpg?v=1774980244 488w, /card-image/large/front/${ID}.jpg?v=1774980244 672w`
		);
		expect(cardImageSrcset('/favicon.ico')).toBeNull();
	});
});

describe('placeholder', () => {
	it('wraps a name into short lines and cuts long names', () => {
		expect(wrapName('Wan Shi Tong, Librarian')).toEqual(['Wan Shi Tong,', 'Librarian']);
		expect(wrapName('Kinnan, Bonder Prodigy')).toEqual(['Kinnan, Bonder', 'Prodigy']);
		expect(wrapName('Supercalifragilisticexpialidocious')).toEqual(['Supercalifragil…']);
		expect(wrapName('a b c d e f g h i j k l m n o p q r s t u v w x y z aa bb cc dd ee ff gg hh ii jj kk ll')).toHaveLength(5);
	});

	it('names the card without the SEO prefix and the set', () => {
		expect(placeholderName('Magic: The Gathering - Vampiric Tutor (Dominaria Remastered)')).toBe('Vampiric Tutor');
		expect(placeholderName('Scroll Rack')).toBe('Scroll Rack');
	});

	it('is an SVG data URL with the escaped name', () => {
		const url = cardPlaceholder('Fire & <Ice>');
		expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
		const svg = decodeURIComponent(url.slice(url.indexOf(',') + 1));
		expect(svg).toContain('Fire &#38; &#60;Ice&#62;');
		expect(svg).toContain('viewBox="0 0 488 680"');
		expect(svg).not.toContain('<Ice>');
	});
});
