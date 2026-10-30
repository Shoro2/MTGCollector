// The collection chart on /prices has two views (owner request 2026-10-30:
// "der preisgraph unter prices soll in zwei versionen gesplittet werden
// (umschaltbar)"): the profit/loss line on its own, and market value against
// purchase cost. Until then all three series shared one chart, and the
// profit line sat near zero under two lines a hundred times larger.

import type { ProfitPoint } from '$lib/server/price-data';

export type ProfitChartView = 'profit' | 'value';

export const PROFIT_CHART_VIEWS: ReadonlyArray<{ id: ProfitChartView; label: string }> = [
	{ id: 'profit', label: 'Profit / Loss' },
	{ id: 'value', label: 'Value and cost' }
];

/** localStorage key of the chosen view (a per-browser convenience). */
export const PROFIT_CHART_VIEW_KEY = 'mtg.prices.chart';

/** The stored view, or the profit view for anything unknown or missing. */
export function parseProfitChartView(stored: unknown): ProfitChartView {
	return stored === 'value' ? 'value' : 'profit';
}

export interface ProfitChartSeries {
	profit: Array<number | null>;
	purchase: Array<number | null>;
	value: Array<number | null>;
}

/**
 * The three series of the history. A day without a comparable copy is a gap
 * (null) in every series, never a zero.
 */
export function profitChartSeries(history: ReadonlyArray<Pick<ProfitPoint, 'total_value' | 'total_purchase'>>): ProfitChartSeries {
	return {
		profit: history.map((h) => (h.total_value == null || h.total_purchase == null ? null : h.total_value - h.total_purchase)),
		purchase: history.map((h) => h.total_purchase),
		value: history.map((h) => h.total_value)
	};
}
