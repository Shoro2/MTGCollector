/**
 * Name-matching helpers for the scanner's name-OCR pipeline.
 * Pure functions over strings — no DOM dependency.
 */

/**
 * Normalize a card name for fuzzy matching: strip diacritics (AEther, Lim-Dul,
 * Jotun), fold case, and reduce punctuation/whitespace to single spaces. This
 * lets OCR that drops accents or mangles apostrophes/commas/hyphens still match
 * the database spelling (e.g. "Jace the Mind Sculptor" vs "Jace, the Mind
 * Sculptor", or "Lim-Dul's Vault" vs the accented original).
 */
export function normalizeName(s: string): string {
	return s
		.normalize('NFD') // split accented chars into base char + combining mark
		.replace(/[̀-ͯ]/g, '') // drop the combining marks so accents fold to ASCII
		.toLowerCase()
		.replace(/æ/g, 'ae') // ligatures NFD doesn't decompose
		.replace(/œ/g, 'oe')
		.replace(/ø/g, 'o')
		.replace(/[^a-z0-9]+/g, ' ') // punctuation -> space
		.trim()
		.replace(/\s+/g, ' ');
}

/** Normalized similarity score (0-1): Levenshtein distance over normalized names. */
export function similarity(a: string, b: string): number {
	const al = normalizeName(a);
	const bl = normalizeName(b);
	if (al === bl) return 1;
	const maxLen = Math.max(al.length, bl.length);
	if (maxLen === 0) return 1;

	// Levenshtein distance via dynamic programming (single-row buffer)
	const prev = Array.from({ length: bl.length + 1 }, (_, i) => i);
	for (let i = 1; i <= al.length; i++) {
		let prevDiag = prev[0];
		prev[0] = i;
		for (let j = 1; j <= bl.length; j++) {
			const temp = prev[j];
			prev[j] = al[i - 1] === bl[j - 1]
				? prevDiag
				: 1 + Math.min(prev[j], prev[j - 1], prevDiag);
			prevDiag = temp;
		}
	}
	return 1 - prev[bl.length] / maxLen;
}

/** Pick the best-matching card name from a result list by similarity to `query`. */
export function bestNameMatch(
	results: Array<Record<string, unknown>>,
	query: string
): { name: string; score: number } {
	let bestName = '';
	let bestScore = 0;
	const seen = new Set<string>();
	for (const r of results) {
		const name = r.name as string;
		if (seen.has(name)) continue;
		seen.add(name);
		const score = similarity(query, name);
		if (score > bestScore) {
			bestScore = score;
			bestName = name;
		}
	}
	return { name: bestName, score: bestScore };
}
