import { describe, expect, it } from 'vitest';
import {
	compactMoney, convertMoney, costIn, currencyMarket, currencySymbol, formatMoney, formatMoneyGrouped, formatQuote,
	isCurrency, parseCurrency, quoteIn
} from './currency';

describe('parseCurrency', () => {
	it('accepts EUR and USD in any case and falls back to EUR', () => {
		expect(parseCurrency('USD')).toBe('USD');
		expect(parseCurrency(' usd ')).toBe('USD');
		expect(parseCurrency('EUR')).toBe('EUR');
		expect(parseCurrency('GBP')).toBe('EUR');
		expect(parseCurrency(null)).toBe('EUR');
		expect(parseCurrency(undefined)).toBe('EUR');
		expect(isCurrency('usd')).toBe(false);
	});
	it('names symbol and market', () => {
		expect(currencySymbol('USD')).toBe('$');
		expect(currencySymbol('EUR')).toBe('€');
		expect(currencyMarket('USD')).toBe('TCGplayer');
		expect(currencyMarket('EUR')).toBe('Cardmarket');
	});
});

describe('quoteIn and costIn', () => {
	it("takes the currency's own market first and converts the other market only when it has none", () => {
		expect(quoteIn(2, 3, 'USD', 0.8)).toBe(3);
		expect(quoteIn(2, 3, 'EUR', 0.8)).toBe(2);
		expect(quoteIn(2, null, 'USD', 0.8)).toBe(2.5);
		expect(quoteIn(null, 10, 'EUR', 0.8)).toBe(8);
		expect(quoteIn(null, null, 'USD', 0.8)).toBeNull();
	});
	it('converts a purchase price only when its currency differs', () => {
		expect(costIn(10, 'USD', 'USD', 0.8)).toBe(10);
		expect(costIn(8, 'EUR', 'USD', 0.8)).toBe(10);
		expect(costIn(10, 'USD', 'EUR', 0.8)).toBe(8);
		// Rows from before the column existed carry no currency: they were euros.
		expect(costIn(5, null, 'EUR', 0.8)).toBe(5);
		expect(costIn(null, 'USD', 'EUR', 0.8)).toBeNull();
		expect(convertMoney(4, 'EUR', 'EUR', 0.8)).toBe(4);
	});
});

describe('formatting', () => {
	it('shows a printing in its own market currency, never a converted guess', () => {
		expect(formatQuote(1.5, 2, 'USD')).toBe('$2.00');
		expect(formatQuote(1.5, 2, 'EUR')).toBe('€1.50');
		// TCGplayer has no price: the Cardmarket price keeps its euro sign.
		expect(formatQuote(0.45, null, 'USD')).toBe('€0.45');
		expect(formatQuote(null, 0.3, 'EUR')).toBe('$0.30');
		expect(formatQuote(null, null, 'USD')).toBe('-');
	});
	it('writes amounts with the symbol in front', () => {
		expect(formatMoney(1.5, 'USD')).toBe('$1.50');
		expect(formatMoney(null, 'EUR')).toBe('-');
		expect(formatMoney(Number.NaN, 'EUR')).toBe('-');
		expect(formatMoneyGrouped(1248.3, 'USD')).toBe('$1,248.30');
		expect(formatMoneyGrouped(-5, 'EUR')).toBe('€-5.00');
	});
	it('keeps chart ticks short in both currencies', () => {
		expect(compactMoney(1500, 'USD')).toBe('$1.5k');
		expect(compactMoney(0.94, 'EUR')).toBe('€0.94');
		expect(compactMoney(-12500, 'USD')).toBe('$-13k');
		expect(compactMoney('n/a', 'USD')).toBe('n/a');
	});
});
