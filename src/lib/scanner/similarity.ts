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

/**
 * Heuristic for OCR words that are noise rather than part of a card name: the
 * name crop ends near the mana cost, and Tesseract (letters-only whitelist)
 * turns the symbols and frame edge into fragments like "SSSERRY", "WU" or "i".
 * Real name words have a vowel, no triple letters and are mostly lowercase.
 */
export function looksLikeOcrJunk(word: string): boolean {
	if (word.length <= 2) return true;
	if (!/[aeiouy]/i.test(word)) return true;
	if (/(.)\1\1/i.test(word)) return true;
	const upper = (word.match(/[A-Z]/g) ?? []).length;
	return upper / word.length >= 0.6;
}

/**
 * Number of 5+-letter words that don't look like OCR junk: does this OCR text
 * say anything about the card? Capitalised words count as junk here too —
 * a showcase frame that prints its name in capitals ("LAST RONIN'S
 * TECHNIQUE") is read well enough to clear NAME_CERTAIN instead, while a
 * capitalised fragment such as "HEASTCE" is what mana symbols turn into.
 */
export function realWordCount(text: string): number {
	return text.split(/\s+/).filter((w) => w.replace(/[^a-z]/gi, '').length >= 5 && !looksLikeOcrJunk(w)).length;
}

/**
 * Similarity of `candidate` to a leading run of `ocr`'s words, for the case
 * where the name was read fine but junk from the mana cost is glued to the end
 * ("Lightning Bolt A SSSERRY"). A prefix only qualifies when its length is
 * within ±25% of the candidate's and *every* remaining word looks like junk,
 * so "Fire Ball" never collapses to the card "Fire". Returns 0 otherwise.
 */
export function prefixSimilarity(ocr: string, candidate: string): number {
	const words = ocr.trim().split(/\s+/).filter(Boolean);
	const target = candidate.trim().length;
	if (target === 0) return 0;
	let best = 0;
	for (let k = 1; k < words.length; k++) {
		const prefix = words.slice(0, k).join(' ');
		if (prefix.length < target * 0.75) continue;
		if (prefix.length > target * 1.25) break;
		if (!words.slice(k).every(looksLikeOcrJunk)) continue;
		best = Math.max(best, similarity(candidate, prefix));
	}
	return best;
}

/** Slight penalty so a clean full-string match always beats a prefix match. */
const PREFIX_MATCH_WEIGHT = 0.97;

/**
 * Names a physical card can show for one database record: the canonical name
 * and, for double-faced / split / adventure cards stored as "Front // Back",
 * each face on its own. The scanner reads a face; the database stores the
 * canonical string.
 */
export function nameAliases(name: string): string[] {
	const faces = name.split(' // ').map((f) => f.trim()).filter(Boolean);
	return faces.length > 1 ? [name, ...faces] : [name];
}

/**
 * Best similarity of the OCR text to any alias of `name` (whole string or
 * junk-tolerant prefix), together with the alias that produced it — the
 * caller needs the alias to judge how much text actually matched ("Cal" is
 * three letters of the face "Call", not of "Beck // Call").
 */
export function bestAlias(query: string, name: string): { alias: string; score: number } {
	let best = { alias: name, score: 0 };
	for (const alias of nameAliases(name)) {
		const score = Math.max(similarity(query, alias), prefixSimilarity(query, alias) * PREFIX_MATCH_WEIGHT);
		if (score > best.score) best = { alias, score };
	}
	return best;
}

/** Best similarity of the OCR text to any alias of `name` (whole string or junk-tolerant prefix). */
export function nameScore(query: string, name: string): number {
	return bestAlias(query, name).score;
}

/**
 * Pick the best-matching card name from a result list by similarity to `query`
 * (the OCR text). Scores the whole string and, when trailing OCR junk drags
 * that down, the matching word-prefix — see prefixSimilarity — against every
 * alias of the name (canonical string and each face), returning the canonical
 * name so result rows can still be grouped by it.
 */
export function bestNameMatch(
	results: Array<Record<string, unknown>>,
	query: string
): { name: string; score: number } {
	return rankNameMatches(results, query, 1)[0] ?? { name: '', score: 0 };
}

/**
 * Distinct names of a result list ranked by similarity to the OCR text, best
 * first, at most `limit`; names scoring 0 are dropped. On a tie the record
 * whose *canonical* string produced the score outranks one matched only
 * through a face alias ("Negate" before "Negate // Negate"); otherwise the
 * input order (the server's relevance) decides.
 */
export function rankNameMatches(
	results: Array<Record<string, unknown>>,
	query: string,
	limit = 3
): Array<{ name: string; score: number }> {
	const seen = new Set<string>();
	const ranked: Array<{ name: string; score: number; canonical: boolean; order: number }> = [];
	for (const r of results) {
		const name = r.name as string;
		if (seen.has(name)) continue;
		seen.add(name);
		const { alias, score } = bestAlias(query, name);
		if (score > 0) ranked.push({ name, score, canonical: alias === name, order: ranked.length });
	}
	ranked.sort((a, b) => b.score - a.score || Number(b.canonical) - Number(a.canonical) || a.order - b.order);
	return ranked.slice(0, limit).map(({ name, score }) => ({ name, score }));
}
