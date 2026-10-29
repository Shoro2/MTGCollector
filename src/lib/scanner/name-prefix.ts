/**
 * Name matching for a name bar that is cut off on the right.
 *
 * In the "rows" scan mode (overlap.ts) the next card of a row covers
 * everything right of the visible strip, so the name OCR reads the *start* of
 * a name: "Lightning B" of Lightning Bolt, "Kriegsh" of Kriegshorn. The
 * whole-string similarity of similarity.ts punishes the missing rest (0.39
 * for "Lightning B" against Lightning Bolt); these scores compare the text
 * with the start of every alias instead.
 *
 * A prefix is weaker evidence than a whole name: "Lightning B" starts
 * Lightning Bolt, Lightning Blast and Lightning Berserker alike, and one
 * misread letter moves a short prefix from one name to another. A prefix
 * therefore identifies a card on its own only when it is long, read well and
 * no other candidate starts nearly the same way (prefixIdentifies); otherwise
 * the collector line decides and the prefix only corroborates it.
 *
 * Pure: strings in, scores out (unit tests in name-prefix.test.ts).
 */
import { aliasLanguage, nameAliases, normalizeName } from './similarity';

/** A text with fewer letters than this says nothing about a name: "Li" starts hundreds. */
export const PREFIX_MIN_LETTERS = 3;
/** A prefix identifies a card on its own only from this many letters on (and read well, and unique). */
export const PREFIX_IDENTIFY_LETTERS = 7;
/** ... and only at this score or better (one misread letter in eight letters scores 0.875). */
export const PREFIX_IDENTIFY = 0.8;
/** A second candidate within this distance of the best makes the prefix ambiguous (one misread letter in seven letters is 0.14). */
export const PREFIX_MARGIN = 0.15;
/**
 * A text that is a whole name, read exactly, identifies the card from this
 * many letters on (when no other name starts that way): it is as safe as an
 * exact read of a short name in the other modes ("Nobody" is all of Nobody,
 * nothing else starts with it).
 */
export const PREFIX_WHOLE_LETTERS = 5;
/**
 * In the names of one set (the set code the collector line shows), a start
 * identifies the card from this many letters on: a set holds a few hundred
 * names, the catalogue tens of thousands ("Catha" starts five catalogue names
 * and one in Innistrad: Midnight Hunt).
 */
export const PREFIX_SET_LETTERS = 5;
/**
 * The prefix score a name needs to count as *fitting* the text when the
 * footer brings it up (a card the collector line names, a name agreeing with a
 * footer hit). The prefix score picks the best prefix length for every name,
 * so unrelated names reach scores the whole-string similarity never gives
 * them: over the 707 name reads of the synthetic rows (2026-10-29) and the 62
 * names of the harness catalogue, 21.5% of the pairs with a different card
 * scored 0.4 or more and 3.4% 0.6 or more, most of those a start the two
 * names share. A footer misread (M10 #104 for #184) "fitted" "l Giant Grc" at
 * 0.45 and beat Giant Growth; 0.4 is the threshold of the other modes.
 */
export const PREFIX_FIT = 0.6;
/** Below this prefix score a name is evidence *against* a footer hit (NAME_CONTRADICT of the other modes, raised for the same reason). */
export const PREFIX_CONTRADICT = 0.5;
/**
 * Trailing characters of the text that may be dropped: the last letter before
 * the covering card is often cut through, and the edge or shadow of that card
 * reads as "l" or "i". Each dropped character costs half an error.
 */
const TRAILING_SKIP = 2;
const DROP_COST = 0.5;

/**
 * Edit distances from the text to every prefix of `a`, for the text and for
 * the text without its last `keep` characters: `rows[k][L]` is the Levenshtein
 * distance of `t.slice(0, t.length - k)` to `a.slice(0, L)`. Prefixes longer
 * than the text plus two characters are never closer and are left out.
 */
export function prefixDistances(t: string, a: string, keep = 0): number[][] {
	const n = t.length;
	const m = Math.min(a.length, n + 2);
	let prev = Array.from({ length: m + 1 }, (_, j) => j);
	const rows: number[][] = [];
	if (n <= keep) rows.unshift(prev.slice());
	for (let i = 1; i <= n; i++) {
		const cur = new Array<number>(m + 1);
		cur[0] = i;
		for (let j = 1; j <= m; j++) {
			cur[j] = t[i - 1] === a[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], cur[j - 1], prev[j - 1]);
		}
		prev = cur;
		if (i >= n - keep) rows.unshift(cur);
	}
	return rows;
}

/** Letters of a normalised text (digits and spaces do not count). */
export const letterCount = (norm: string): number => norm.replace(/[^a-z]/g, '').length;

/**
 * A one- or two-character token at the start of a normalised text: the card's
 * own left border or the edge of the card below, read as a letter ("l Punk",
 * "fl Rotter", "i Bot" on the synthetic rows). Returns the text without it, or
 * the text itself.
 */
export function stripLeadingToken(norm: string): string {
	const m = /^[a-z0-9]{1,2} (?=\S)/.exec(norm);
	return m ? norm.slice(m[0].length) : norm;
}

/** Edit-distance prefix score of `t` against `a`, with `extra` errors already spent (dropped leading characters). */
function prefixCore(t: string, a: string, extra: number, length: number): number {
	if (letterCount(t) < PREFIX_MIN_LETTERS) return 0;
	if (t === a && extra === 0) return 1;
	const rows = prefixDistances(t, a, Math.min(TRAILING_SKIP, t.length - 1));
	let best = 0;
	rows.forEach((row, k) => {
		for (let L = 1; L < row.length; L++) {
			const s = 1 - (row[L] + DROP_COST * k + extra) / Math.max(length, L);
			if (s > best) best = s;
		}
	});
	return Math.max(0, best);
}

/**
 * prefixScore over texts that are already normalised (the server's scans keep
 * them normalised). A short leading token (stripLeadingToken) may be written
 * off like the trailing characters, at half an error per character.
 */
export function prefixScoreNorm(t: string, a: string): number {
	if (a.length === 0) return 0;
	const direct = prefixCore(t, a, 0, t.length);
	const rest = stripLeadingToken(t);
	if (rest === t) return direct;
	return Math.max(direct, prefixCore(rest, a, DROP_COST * (t.length - rest.length - 1), t.length));
}

/**
 * How well the OCR text matches the start of `alias` (0-1): the best
 * edit-distance similarity between the text and a prefix of the alias of
 * about the text's length, with up to two characters at the end of the text
 * written off at half an error each. A whole alias is its own prefix, so a
 * fully visible name scores like it does in similarity().
 */
export function prefixScore(text: string, alias: string): number {
	return prefixScoreNorm(normalizeName(text), normalizeName(alias));
}

/**
 * Cheap prefilter of the server's scans over every name: whether at least 40%
 * of the text's bigrams occur within the start of the normalised alias (its
 * first `length` + 3 characters). A text that clears 0.6 in prefixScore shares
 * far more; the filter only spares the edit-distance table for the rest.
 */
export function startShares(textBigrams: readonly string[], aliasNorm: string, length: number): boolean {
	if (textBigrams.length === 0) return false;
	const head = aliasNorm.slice(0, length + 3);
	let shared = 0;
	for (const b of textBigrams) if (head.includes(b)) shared++;
	return shared >= 0.4 * textBigrams.length;
}

/** Best prefix score of the OCR text against any alias of `name` (canonical string, faces, printed names), with that alias. */
export function bestPrefixAlias(text: string, name: string): { alias: string; score: number } {
	const t = normalizeName(text);
	let best = { alias: name, score: 0 };
	for (const alias of nameAliases(name)) {
		const score = prefixScoreNorm(t, normalizeName(alias));
		if (score > best.score) best = { alias, score };
	}
	return best;
}

/** Best prefix score of the OCR text against any alias of `name`. */
export function prefixNameScore(text: string, name: string): number {
	return bestPrefixAlias(text, name).score;
}

/**
 * Distinct names of a result list ranked by prefix score, best first, at most
 * `limit` (names scoring 0 are dropped); the counterpart of rankNameMatches()
 * for a truncated name bar. On a tie the shorter name goes first (with the
 * same start, the shorter one has fewer letters the text did not show), then
 * the input order. `lang` is the language of the alias that matched.
 */
export function rankPrefixMatches(
	results: Array<Record<string, unknown>>,
	query: string,
	limit = 5
): Array<{ name: string; score: number; lang: string }> {
	const seen = new Set<string>();
	const ranked: Array<{ name: string; score: number; lang: string; length: number; order: number }> = [];
	for (const r of results) {
		const name = r.name as string;
		if (seen.has(name)) continue;
		seen.add(name);
		const { alias, score } = bestPrefixAlias(query, name);
		if (score > 0) ranked.push({ name, score, lang: aliasLanguage(name, alias), length: alias.length, order: ranked.length });
	}
	ranked.sort((a, b) => b.score - a.score || a.length - b.length || a.order - b.order);
	return ranked.slice(0, limit).map(({ name, score, lang }) => ({ name, score, lang }));
}

/**
 * Whether the best prefix candidate identifies the card without the
 * collector line: read well (PREFIX_IDENTIFY), long enough
 * (PREFIX_IDENTIFY_LETTERS, or PREFIX_WHOLE_LETTERS when the text is the
 * whole name) and no other candidate within PREFIX_MARGIN. The
 * candidates must come from a search that returns every name starting like
 * the text (the server's prefix scan does), or a missing rival would make a
 * shared start look unique.
 */
export function prefixIdentifies(best: { name: string; score: number }, candidates: ReadonlyArray<{ name: string; score: number }>, text: string): boolean {
	if (best.score < PREFIX_IDENTIFY) return false;
	const norm = normalizeName(text);
	const shown = stripLeadingToken(norm);
	const whole = nameAliases(best.name).some((alias) => {
		const a = normalizeName(alias);
		return a === norm || a === shown;
	});
	if (letterCount(shown) < (whole ? PREFIX_WHOLE_LETTERS : PREFIX_IDENTIFY_LETTERS)) return false;
	return !candidates.some((c) => c.name !== best.name && c.score >= best.score - PREFIX_MARGIN);
}
