import { describe, expect, it } from 'vitest';
import { isImportable, isSelectedPrinting, scanCounts, scanSummary, type ScanResult } from './results';

const card = (overrides: Partial<ScanResult> = {}): ScanResult => ({
	status: 'found', printingState: 'unknown', results: [{ id: 'a' }, { id: 'b' }], selectedResultIdx: 0, ...overrides
});

describe('scanner printing selection', () => {
	it('does not preselect or import a printing when only the identity is confirmed', () => {
		const unresolved = card();
		expect(isImportable(unresolved)).toBe(false);
		expect(isSelectedPrinting(unresolved, 0)).toBe(false);
		expect(isSelectedPrinting(unresolved, 1)).toBe(false);
		expect(isImportable(card({ results: [{ id: 'a' }] }))).toBe(false);
	});
	it('allows only the established printing, including an explicit user selection', () => {
		const selected = card({ printingState: 'confirmed', selectedResultIdx: 1 });
		expect(isImportable(selected)).toBe(true);
		expect(isSelectedPrinting(selected, 0)).toBe(false);
		expect(isSelectedPrinting(selected, 1)).toBe(true);
		for (const status of ['likely', 'conflict', 'not_found']) expect(isImportable(card({ ...selected, status }))).toBe(false);
		expect(isImportable(card({ printingState: 'confirmed', selectedResultIdx: 2 }))).toBe(false);
	});
	it('reports confirmed identities separately from established printings', () => {
		const cards = [card(), card({ printingState: 'confirmed' }), card({ status: 'likely' }), card({ status: 'not_found' })];
		expect(scanCounts(cards)).toEqual({ total: 4, identified: 2, printings: 1, openPrintings: 1, toConfirm: 1 });
		expect(scanSummary(cards)).toBe('2/4 identified, 1/4 printings confirmed, 1 printing to choose, 1 to confirm');
	});
});
