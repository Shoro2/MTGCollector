// Shared Chart.js options for the line charts (profit/loss on /prices, the
// per-card price history on /prices and /collection, the printing page).
//
// Every chart sits in a `.chart-frame` container (src/app.css) that has a
// fixed height on phones and a 2:1 aspect ratio from `sm` up, and Chart.js
// fills it (`maintainAspectRatio: false`). Before 2026-10-30 the charts kept
// Chart.js's own 2:1 ratio: on a 360 px phone the profit chart was about
// 140 px tall, its three-row legend and the rotated date labels took all of
// it, and the plot area collapsed into a flat line at the lowest tick.

import type { ChartOptions } from 'chart.js';
import { compactMoney, type Currency } from './currency';

const TEXT = '#b0bec5';
const GRID = '#334155';

/** Euro tick label that stays short on a narrow y axis: €950, €1.5k, €-12k. */
export function compactEuro(value: number | string): string {
	return compactMoney(value, 'EUR');
}

/**
 * Options for a line chart in a `.chart-frame`. `currency` formats the y axis
 * as that currency (the user's display currency); `euro: false` keeps plain
 * numbers (the printing page plots EUR and USD on one axis).
 */
export function lineChartOptions({ euro = true, currency = 'EUR' }: { euro?: boolean; currency?: Currency } = {}): ChartOptions<'line'> {
	return {
		responsive: true,
		maintainAspectRatio: false,
		// One tap anywhere in a column shows every series of that day.
		interaction: { mode: 'index', intersect: false },
		plugins: {
			legend: {
				labels: { color: TEXT, boxWidth: 12, boxHeight: 12, padding: 10 }
			}
		},
		scales: {
			x: {
				// Upright date labels; Chart.js drops the ones that do not fit,
				// so a phone shows a few dates and a desktop more.
				ticks: { color: TEXT, maxRotation: 0, autoSkip: true, autoSkipPadding: 12 },
				grid: { color: GRID }
			},
			y: {
				ticks: euro ? { color: TEXT, callback: (v) => compactMoney(v, currency) } : { color: TEXT },
				grid: { color: GRID }
			}
		}
	};
}
