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
	const bolt = { name: 'Lightning Bolt', type_line: 'Instant', set_name: 'Foundations', oracle_text: 'Lightning Bolt deals 3 damage to any target.' };
	it('leads with the lowest price and the printing count', () => {
		const meta = cardPageMeta(bolt, [p('a', { price_eur: 0.25 }), p('b', { price_eur: 450 })]);
		expect(meta.title).toBe('Lightning Bolt – MTG price from €0.25, 2 printings');
		expect(meta.description).toBe('Lightning Bolt (Instant): 2 printings from €0.25 with price history. Lightning Bolt deals 3 damage to any target.');
	});
	it('drops title details until the title fits 60 characters', () => {
		const michiko = { name: 'Michiko Konda, Truth Seeker', type_line: 'Legendary Creature — Human Advisor' };
		expect(cardPageMeta(michiko, [p('a', { price_eur: 5.02 }), p('b', { price_eur: 20.91 })]).title).toBe('Michiko Konda, Truth Seeker – MTG price from €5.02');
		const long = 'Asmoranomardicadaistinaculdacar, the Uncounted Herald';
		expect(cardPageMeta({ name: long, type_line: null }, [p('a', { price_eur: 1 })]).title).toBe(long);
	});
	it('never promises a price for a digital-only card', () => {
		const killian = { name: 'Killian, Spotlight Chaser', type_line: 'Legendary Creature — Human Bard', set_name: 'Alchemy: Reality Fracture',
			oracle_text: 'Whenever a source you control deals noncombat damage to an opponent, seek a card with mana value equal to the damage dealt.\nDiscard that card at the beginning of the next end step.' };
		const meta = cardPageMeta(killian, [p('a', { is_paper: 0 })]);
		expect(meta.title).toBe('Killian, Spotlight Chaser – digital MTG card');
		expect(meta.description).toBe('Killian, Spotlight Chaser (Legendary Creature — Human Bard): digital-only card from Alchemy: Reality Fracture. Whenever a source you control deals…');
	});
	it('says when a paper card has no price yet', () => {
		const meta = cardPageMeta({ name: 'Soldier', type_line: 'Token Creature — Soldier', set_name: 'Test Set' }, [p('a'), p('b', { is_paper: 0 })]);
		expect(meta.title).toBe('Soldier – MTG card, Test Set');
		expect(meta.description).toBe('Soldier (Token Creature — Soldier): 2 printings, no price yet.');
	});
	it('marks a foil-only lowest price', () => {
		const meta = cardPageMeta({ name: 'Smaug', type_line: 'Legendary Creature — Dragon' }, [p('a', { price_eur_foil: 3 })]);
		expect(meta.title).toBe('Smaug – MTG price from €3.00');
		expect(meta.description).toBe('Smaug (Legendary Creature — Dragon): 1 printing from €3.00 (foil) with price history.');
	});
	it('keeps every description within 155 characters, cut at a word', () => {
		const rules = 'Flying, vigilance, trample. '.repeat(12);
		const description = cardPageMeta({ ...bolt, oracle_text: rules }, [p('a', { price_eur: 1 })]).description;
		expect(description.length).toBeLessThanOrEqual(155);
		expect(description).toMatch(/[a-z]…$/);
	});
});
