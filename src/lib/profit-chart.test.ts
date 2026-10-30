import { describe, expect, it } from 'vitest';
import { PROFIT_CHART_VIEWS, parseProfitChartView, profitChartSeries } from './profit-chart';

describe('parseProfitChartView', () => {
	it('keeps the two known views', () => {
		expect(parseProfitChartView('profit')).toBe('profit');
		expect(parseProfitChartView('value')).toBe('value');
	});

	it('falls back to the profit view', () => {
		expect(parseProfitChartView(null)).toBe('profit');
		expect(parseProfitChartView('')).toBe('profit');
		expect(parseProfitChartView('VALUE')).toBe('profit');
	});

	it('offers both views, profit first', () => {
		expect(PROFIT_CHART_VIEWS.map((v) => v.id)).toEqual(['profit', 'value']);
	});
});

describe('profitChartSeries', () => {
	it('subtracts the purchase cost from the market value per day', () => {
		const series = profitChartSeries([
			{ total_value: 120, total_purchase: 100 },
			{ total_value: 80, total_purchase: 100 }
		]);
		expect(series.profit).toEqual([20, -20]);
		expect(series.purchase).toEqual([100, 100]);
		expect(series.value).toEqual([120, 80]);
	});

	it('keeps a day without both prices as a gap, not a zero', () => {
		const series = profitChartSeries([
			{ total_value: null, total_purchase: null },
			{ total_value: 50, total_purchase: null },
			{ total_value: 0, total_purchase: 0 }
		]);
		expect(series.profit).toEqual([null, null, 0]);
		expect(series.value).toEqual([null, 50, 0]);
	});
});
