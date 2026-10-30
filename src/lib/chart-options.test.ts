import { describe, expect, it } from 'vitest';
import { compactEuro, lineChartOptions } from './chart-options';

describe('compactEuro', () => {
	it('keeps small prices exact', () => {
		expect(compactEuro(0)).toBe('€0');
		expect(compactEuro(0.94)).toBe('€0.94');
		expect(compactEuro(2.5)).toBe('€2.5');
		expect(compactEuro(950)).toBe('€950');
	});

	it('shortens thousands', () => {
		expect(compactEuro(1000)).toBe('€1k');
		expect(compactEuro(1500)).toBe('€1.5k');
		expect(compactEuro(12500)).toBe('€13k');
		expect(compactEuro(-5000)).toBe('€-5k');
		expect(compactEuro(-2500)).toBe('€-2.5k');
	});

	it('accepts the string ticks Chart.js may pass', () => {
		expect(compactEuro('2000')).toBe('€2k');
		expect(compactEuro('n/a')).toBe('n/a');
	});
});

describe('lineChartOptions', () => {
	it('lets the container decide the height', () => {
		const options = lineChartOptions();
		expect(options.responsive).toBe(true);
		expect(options.maintainAspectRatio).toBe(false);
	});

	it('keeps date labels upright and skips the ones that do not fit', () => {
		const ticks = lineChartOptions().scales?.x?.ticks as Record<string, unknown>;
		expect(ticks.maxRotation).toBe(0);
		expect(ticks.autoSkip).toBe(true);
	});

	it('formats the y axis in euros only when asked', () => {
		const euro = lineChartOptions().scales?.y?.ticks as { callback?: (v: number) => string };
		expect(euro.callback?.(1500)).toBe('€1.5k');
		const plain = lineChartOptions({ euro: false }).scales?.y?.ticks as { callback?: unknown };
		expect(plain.callback).toBeUndefined();
	});

	it('labels the y axis in the chosen currency', () => {
		const dollars = lineChartOptions({ currency: 'USD' }).scales?.y?.ticks as { callback?: (v: number) => string };
		expect(dollars.callback?.(1500)).toBe('$1.5k');
	});
});
