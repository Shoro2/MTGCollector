import { describe, it, expect } from 'vitest';
import { displayPrice, priceDivergence, isSuspiciousDivergence, formatPrice } from './utils';

describe('displayPrice', () => {
	it('prefers the non-foil EUR price', () => {
		expect(displayPrice({ price_eur: 1.5, price_usd: 2, price_eur_foil: 9, price_usd_foil: 10 })).toEqual({
			text: '\u20ac1.50',
			foil: false
		});
	});

	it('falls back to USD before considering foil prices', () => {
		expect(displayPrice({ price_eur: null, price_usd: 2, price_eur_foil: 9 })).toEqual({ text: '$2.00', foil: false });
	});

	it('shows the foil price, flagged, for foil-only printings', () => {
		// e.g. The Hobbit extras: Scryfall has eur_foil only
		expect(displayPrice({ price_eur: null, price_usd: null, price_eur_foil: 300, price_usd_foil: 24000 })).toEqual({
			text: '\u20ac300.00',
			foil: true
		});
		expect(displayPrice({ price_eur_foil: null, price_usd_foil: 24000 })).toEqual({ text: '$24000.00', foil: true });
	});

	it('returns null when there is no price at all', () => {
		expect(displayPrice({})).toBeNull();
		expect(displayPrice({ price_eur: null, price_usd: null, price_eur_foil: null, price_usd_foil: null })).toBeNull();
	});
});

describe('priceDivergence', () => {
	it('is near 1 for consistent markets', () => {
		const d = priceDivergence(10, 11, 0.9);
		expect(d).not.toBeNull();
		expect(d!.ratio).toBeCloseTo(10 / 9.9, 6);
		expect(isSuspiciousDivergence(d)).toBe(false);
	});

	it('flags a collapsed Cardmarket trend against a sane USD price', () => {
		// Smaug the Magnificent (HOB #249): eur_foil 300 vs usd_foil ~24000
		const d = priceDivergence(300, 24000, 0.86);
		expect(d!.usdAsEur).toBeCloseTo(20640, 6);
		expect(d!.ratio).toBeLessThan(0.2);
		expect(isSuspiciousDivergence(d)).toBe(true);
	});

	it('flags the opposite direction too', () => {
		expect(isSuspiciousDivergence(priceDivergence(1000, 10, 0.9))).toBe(true);
	});

	it('is null when either side is missing or non-positive', () => {
		expect(priceDivergence(null, 10, 0.9)).toBeNull();
		expect(priceDivergence(10, null, 0.9)).toBeNull();
		expect(priceDivergence(0, 10, 0.9)).toBeNull();
		expect(priceDivergence(10, 10, 0)).toBeNull();
		expect(isSuspiciousDivergence(null)).toBe(false);
	});
});

describe('formatPrice', () => {
	it('renders EUR first, USD as fallback, dash otherwise', () => {
		expect(formatPrice(3, 4)).toBe('\u20ac3.00');
		expect(formatPrice(null, 4)).toBe('$4.00');
		expect(formatPrice(null, null)).toBe('-');
	});
});
