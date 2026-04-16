// Lazy Chart.js loader. Collection and prices pages only need Chart.js
// when the user opens a chart modal (or reveals the profit chart on
// /prices), so we keep it out of the initial route bundle.

import type { Chart as ChartType } from 'chart.js';

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
	return mod.Chart;
}
