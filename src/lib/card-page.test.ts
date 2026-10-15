import { describe, expect, it } from 'vitest';
import { cardPageMeta, cheapestPrice, pickMainPrinting, type PrintingSummary } from './card-page';

const p = (id: string, over: Partial<PrintingSummary> = {}): PrintingSummary => ({
	id, set_code: 'tst', set_name: 'Test', collector_number: '1', rarity: 'rare', released_at: '2020-01-01',
	image_uri: 'img', local_image_path: null, price_eur: null, price_usd: null, price_eur_foil: null, price_usd_foil: null, ...over
});

describe('pickMainPrinting', () => {
	it('prefers a priced printing with an image, newest first', () => {
		const main = pickMainPrinting([
			p('newest-no-image', { released_at: '2025-01-01', image_uri: null, price_eur: 1 }),
			p('new-foil-only', { released_at: '2024-01-01', price_eur_foil: 9 }),
			p('regular', { released_at: '2023-01-01', price_usd: 2 }),
			p('old', { released_at: '2010-01-01', price_eur: 5 })
		]);
		expect(main.id).toBe('regular');
	});
	it('still returns something for unpriced, imageless cards', () => {
		expect(pickMainPrinting([p('a', { image_uri: null }), p('b', { image_uri: null, released_at: '2021-01-01' })]).id).toBe('b');
	});
});

describe('cheapestPrice', () => {
	it('takes the lowest EUR price, then foil, then USD', () => {
		expect(cheapestPrice([p('a', { price_eur: 5.02 }), p('b', { price_eur: 20.91, price_usd: 1 })])).toEqual({ text: '€5.02', foil: false });
		expect(cheapestPrice([p('a', { price_eur_foil: 3 }), p('b', { price_usd: 1 })])).toEqual({ text: '€3.00', foil: true });
		expect(cheapestPrice([p('a', { price_usd: 4 }), p('b', { price_usd: 2.5 })])).toEqual({ text: '$2.50', foil: false });
		expect(cheapestPrice([p('a')])).toBeNull();
	});
});

describe('cardPageMeta', () => {
	it('names the card, its printings and the lowest price', () => {
		const meta = cardPageMeta({ name: 'Michiko Konda, Truth Seeker', type_line: 'Legendary Creature — Human Advisor' },
			[p('a', { price_eur: 5.02 }), p('b', { price_eur: 20.91 })]);
		expect(meta.title).toBe('Michiko Konda, Truth Seeker – Price, Printings & Rules');
		expect(meta.description).toBe('Michiko Konda, Truth Seeker (Legendary Creature — Human Advisor): 2 printings, from €5.02. Compare the price of every printing, read the rules text and check format legality.');
	});
	it('handles a single unpriced printing', () => {
		expect(cardPageMeta({ name: 'Soldier', type_line: 'Token Creature — Soldier' }, [p('a')]).description)
			.toBe('Soldier (Token Creature — Soldier): 1 printing. Compare the price of every printing, read the rules text and check format legality.');
	});
});
