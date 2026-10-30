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

const TEXT = '#b0bec5';
const GRID = '#334155';

/** Euro tick label that stays short on a narrow y axis: €950, €1.5k, €-12k. */
export function compactEuro(value: number | string): string {
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n)) return String(value);
	const abs = Math.abs(n);
	if (abs >= 1000) {
		const thousands = n / 1000;
		const digits = abs >= 10000 || Number.isInteger(thousands) ? 0 : 1;
		return `€${trimZeros(thousands.toFixed(digits))}k`;
	}
	if (abs === 0) return '€0';
	return `€${trimZeros(n.toFixed(abs >= 10 ? 0 : 2))}`;
}

function trimZeros(text: string): string {
	return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

/**
 * Options for a line chart in a `.chart-frame`. `euro` formats the y axis as
 * euros (the printing page also plots USD and keeps plain numbers).
 */
export function lineChartOptions({ euro = true }: { euro?: boolean } = {}): ChartOptions<'line'> {
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
				ticks: euro ? { color: TEXT, callback: (v) => compactEuro(v) } : { color: TEXT },
				grid: { color: GRID }
			}
		}
	};
}
