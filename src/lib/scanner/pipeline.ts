/**
 * Shared scanner pipeline helpers — pure string/data logic, no DOM or OpenCV.
 */

import type { CollectorInfo } from './parse';

export type CardRow = Record<string, unknown>;

/** Lower-case, leading zeros of the numeric part stripped, suffix kept ("0085p" -> "85p"). */
export function normalizeCollectorNumber(n: string): string {
	return String(n).trim().toLowerCase().replace(/^0+(?=\d)/, '');
}

const STRONG_SOURCES: ReadonlyArray<CollectorInfo['numberSource']> = ['fraction', 'pair', 'rarity'];

/**
 * Given several reprints that all share a name, pick the single printing the
 * parsed collector line identifies. Evidence is used strictly in order of
 * specificity and only when it singles out one printing:
 *  1. set code + full collector number (suffix preserved, only leading zeros
 *     of the numeric part normalised);
 *  2. set code alone, when exactly one printing has it (a code one glyph
 *     away from exactly one candidate set counts as that set — the name is
 *     already certain here);
 *  3. collector number alone, when it came from a structural parse (fraction,
 *     rarity-prefixed, number/total pair) and exactly one printing has it.
 * Arbitrary digit sequences in the footer text (copyright years, set totals)
 * are never used, and conflicting or ambiguous evidence yields null rather
 * than a guess. `bottomText` is only echoed into the log.
 */
export function disambiguateReprints(
	results: CardRow[],
	bottomText: string,
	setCode: string,
	collectorNumber: string,
	numberSource: CollectorInfo['numberSource'] = 'none'
): { match: CardRow | null; log: string[] } {
	const log: string[] = [];
	const set = setCode.trim().toLowerCase();
	const num = collectorNumber ? normalizeCollectorNumber(collectorNumber) : '';
	log.push(`${results.length} reprints to disambiguate (set="${set}" number="${num}" source=${numberSource}, text="${bottomText.slice(0, 40)}")`);

	const sameSet = set ? results.filter((r) => String(r.set_code).toLowerCase() === set) : [];
	const sameNumber = num ? results.filter((r) => normalizeCollectorNumber(String(r.collector_number)) === num) : [];

	if (set && num) {
		const both = sameSet.filter((r) => normalizeCollectorNumber(String(r.collector_number)) === num);
		log.push(`set+number match -> ${both.length}`);
		if (both.length === 1) return { match: both[0], log };
	}
	if (set) {
		log.push(`set-only match -> ${sameSet.length}`);
		if (sameSet.length === 1) return { match: sameSet[0], log };
		// The name is certain, so a set code the OCR got one glyph wrong (THT
		// for TMT) may still pick the printing — when exactly one candidate set
		// is one substitution away.
		if (sameSet.length === 0) {
			const near = [...new Set(results.map((r) => String(r.set_code).toLowerCase()))].filter((code) => code.length === set.length && oneSubstitutionApart(code, set));
			const nearRows = near.length === 1 ? results.filter((r) => String(r.set_code).toLowerCase() === near[0]) : [];
			log.push(`near set code (${near.join(', ') || 'none'}) -> ${nearRows.length}`);
			if (nearRows.length === 1) return { match: nearRows[0], log };
		}
	}
	if (num && STRONG_SOURCES.includes(numberSource)) {
		log.push(`number-only match (${numberSource}) -> ${sameNumber.length}`);
		if (sameNumber.length === 1) return { match: sameNumber[0], log };
	} else if (num) {
		log.push(`number "${num}" is ${numberSource}: not used on its own`);
	}
	log.push('could not disambiguate');
	return { match: null, log };
}

function oneSubstitutionApart(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) return false;
	return diff === 1;
}
