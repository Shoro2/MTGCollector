// Lazy Chart.js loader. Collection and prices pages only need Chart.js
// when the user opens a chart modal (or reveals the profit chart on
// /prices), so we keep it out of the initial route bundle.

import type { Chart as ChartType } from 'chart.js';
import { rootFontScale } from './ui-scale';

let chartModulePromise: Promise<typeof import('chart.js')> | null = null;
let registered = false;

export async function loadChart(): Promise<typeof ChartType> {
	if (!chartModulePromise) {
		chartModulePromise = import('chart.js');
	}
	const mod = await chartModulePromise;
	if (!registered) {
		mod.Chart.register(...mod.registerables);
		registered = true;
	}
	// Chart.js draws its text in pixels (12 px by default); follow the display
	// size from /settings, which scales the rem-based page around the chart.
	mod.Chart.defaults.font.size = Math.round(12 * rootFontScale());
	return mod.Chart;
}
