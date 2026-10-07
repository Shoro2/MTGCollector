/** Shared rules for selecting, importing and reporting scanner results. No DOM or database. */
export type ScanResult = {
	status: string;
	printingState: string;
	results: Array<Record<string, unknown>>;
	selectedResultIdx: number;
};

/** A confirmed identity and an explicitly established printing are both required. */
export function isImportable(card: ScanResult): boolean {
	return card.status === 'found' && card.printingState === 'confirmed'
		&& card.results[card.selectedResultIdx] !== undefined;
}

export function isSelectedPrinting(card: ScanResult, index: number): boolean {
	return isImportable(card) && card.selectedResultIdx === index;
}

export function scanCounts(cards: ScanResult[]) {
	return {
		total: cards.length,
		identified: cards.filter((c) => c.status === 'found').length,
		printings: cards.filter(isImportable).length,
		openPrintings: cards.filter((c) => c.status === 'found' && !isImportable(c)).length,
		toConfirm: cards.filter((c) => c.status === 'likely' || c.status === 'conflict').length
	};
}

export function scanSummary(cards: ScanResult[]): string {
	const c = scanCounts(cards);
	return `${c.identified}/${c.total} identified, ${c.printings}/${c.total} printings confirmed`
		+ (c.openPrintings ? `, ${c.openPrintings} printing${c.openPrintings === 1 ? '' : 's'} to choose` : '')
		+ (c.toConfirm ? `, ${c.toConfirm} to confirm` : '');
}
