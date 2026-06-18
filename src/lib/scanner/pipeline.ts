/**
 * Shared scanner pipeline helpers.
 *
 * Phase 2 (Task 2.1) consolidates the two scanners (`/scan` and
 * `/collection/scan`) onto one accurate, tested pipeline. This module is the
 * home for the stages they should share — detection, warp, region extraction,
 * OCR, candidate matching, and foil evidence — extracted incrementally so each
 * step stays behaviour-preserving and unit-testable.
 *
 * First extracted stage: reprint disambiguation (was inline in
 * `/scan`'s applyBottomMatch). Pure string/data logic, no DOM or OpenCV.
 */

export type CardRow = Record<string, unknown>;

/**
 * Given several reprints that all share a name, pick the single printing that
 * best matches the OCR'd bottom collector line.
 *
 * Strategy (first hit wins):
 *  1. A known collector number appears among the digit sequences in the text.
 *  2. The parsed set code + collector number uniquely identify a printing.
 *  3. The parsed set code alone matches exactly one printing.
 *
 * Returns the matched row (or null if it cannot be disambiguated) plus the
 * per-step debug lines the caller can prefix and log.
 */
export function disambiguateReprints(
	results: CardRow[],
	bottomText: string,
	setCode: string,
	collectorNumber: string
): { match: CardRow | null; log: string[] } {
	const log: string[] = [];
	let match: CardRow | undefined;

	// Extract all digit sequences from bottom text for matching.
	const digitSeqs = [...bottomText.matchAll(/\d+/g)].map((m) => m[0]);
	log.push(`${results.length} reprints to disambiguate, digit sequences: [${digitSeqs.join(', ')}]`);

	// 1. Try matching known collector numbers in the bottom text.
	const numMatches = results.filter((r) => {
		const cn = String(r.collector_number);
		const cnPadded = cn.padStart(3, '0');
		// Exact match, or collector number contained in a digit sequence
		// (e.g. "8202" contains "202", "0188" contains "188").
		return digitSeqs.some(
			(d) =>
				d === cn ||
				d === cnPadded ||
				d.replace(/^0+/, '') === cn ||
				d === cn.padStart(4, '0') ||
				d.includes(cn) ||
				d.includes(cnPadded)
		);
	});
	log.push(`collector number matching -> ${numMatches.length} matches`);
	if (numMatches.length === 1) {
		match = numMatches[0];
		log.push(`unique number match: ${match.set_code}#${match.collector_number}`);
	}

	// 2. Try set code + collector number from the generic parser.
	if (!match && setCode && collectorNumber) {
		match = results.find(
			(r) =>
				(r.set_code as string).toLowerCase() === setCode.toLowerCase() &&
				(String(r.collector_number) === collectorNumber ||
					String(r.collector_number) === collectorNumber.replace(/^0+/, ''))
		);
		log.push(`set+number match (${setCode}#${collectorNumber}) -> ${match ? 'found' : 'none'}`);
	}

	// 3. Try just the set code.
	if (!match && setCode) {
		const setMatches = results.filter(
			(r) => (r.set_code as string).toLowerCase() === setCode.toLowerCase()
		);
		if (setMatches.length === 1) match = setMatches[0];
		log.push(`set-only match (${setCode}) -> ${setMatches.length} matches`);
	}

	return { match: match ?? null, log };
}
