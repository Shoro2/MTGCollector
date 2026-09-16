import type { Statement } from 'better-sqlite3';
import { sqlite } from './db.js';
import { setsCache } from './cache.js';
import { nameAliases, normalizeName, rankNameMatches, similarity } from '../scanner/similarity.js';

const selectFields = `id, name, set_name, set_code, collector_number, image_uri, local_image_path, price_eur, price_eur_foil, price_usd, price_usd_foil, rarity`;
// Art-series records are not playable cards: Scryfall lists them as
// "Name // Name" with the artwork of a real card, so a scanned name matched
// them as often as the card itself (11 of 23 wrong identities on the eight
// development photos against the full pool). The scanner never returns them.
const NOT_ART_SERIES = `layout <> 'art_series'`;
/** Rows a fuzzy path may contribute before the names are ranked; the old 20 cut the right name from common-word queries ("Escave Tunnel"). */
const FUZZY_ROWS = 200;
/** Distinct names a fuzzy search returns, best similarity first. */
const FUZZY_NAMES = 20;
/** Printings per returned name in a fuzzy result (the fusion fetches the complete list separately). */
const ROWS_PER_NAME = 10;

export type CardRow = Record<string, unknown>;
export type SearchResult = { results: CardRow[]; matchType: 'exact' | 'like' | 'fts' | 'fuzzy' | 'none' };

// Statements are lazily prepared so module load doesn't hit the DB before
// initDb() has created the required tables. The build bundler imports this
// module as part of discovering routes, which used to fail on a fresh DB.
let _exact: Statement | undefined;
let _like: Statement | undefined;
let _core: Statement | undefined;
let _fts: Statement | undefined;
let _setNum: Statement | undefined;
let _printings: Statement | undefined;

// Exact name: the canonical name, a "Front // Back" record whose front face
// is the query, or any record with a face of that name (card_faces) — the
// scanner reads the face printed on the card, the database stores the
// canonical string.
const exactStmt = () => (_exact ??= sqlite.prepare(`SELECT ${selectFields} FROM cards
	WHERE (name = ? OR name LIKE ? OR id IN (SELECT card_id FROM card_faces WHERE name = ?)) AND ${NOT_ART_SERIES}
	ORDER BY released_at DESC LIMIT 10`));
const coreStmt = () => (_core ??= sqlite.prepare(`SELECT ${selectFields} FROM cards WHERE name LIKE ? AND ${NOT_ART_SERIES} ORDER BY released_at DESC LIMIT ${FUZZY_ROWS}`));
const printingsStmt = () => (_printings ??= sqlite.prepare(`SELECT ${selectFields} FROM cards WHERE name = ? AND ${NOT_ART_SERIES} ORDER BY released_at DESC LIMIT 200`));
const likeStmt = () => (_like ??= sqlite.prepare(`SELECT ${selectFields} FROM cards WHERE name LIKE ? AND ${NOT_ART_SERIES} ORDER BY released_at DESC LIMIT 20`));
// cards_fts is an external-content FTS5 index (content='cards',
// content_rowid='rowid'): it stores only name/type_line/oracle_text and reuses
// cards.rowid as its own rowid — there is NO card_id column. So the join must be
// cards.rowid = cards_fts.rowid. (A prior version joined on a non-existent
// cards_fts.card_id, which threw "no such column" and made every name search
// fall through to the slow LIKE scan.) Results are ranked by bm25 relevance
// first and only then by release date, so the closest textual match wins rather
// than just the newest printing. bm25() needs the fts table in scope (hence the
// JOIN), and the selected columns are qualified to cards.* because cards_fts
// also exposes a `name` column.
const ftsSelectFields = selectFields
	.split(',')
	.map((f) => `cards.${f.trim()}`)
	.join(', ');
const ftsStmt = () => (_fts ??= sqlite.prepare(
	`SELECT ${ftsSelectFields}
	FROM cards_fts
	JOIN cards ON cards.rowid = cards_fts.rowid
	WHERE cards_fts MATCH ? AND cards.${NOT_ART_SERIES}
	ORDER BY bm25(cards_fts), cards.released_at DESC
	LIMIT ?`
));
const setNumStmt = () => (_setNum ??= sqlite.prepare(`SELECT ${selectFields} FROM cards WHERE set_code = ? AND collector_number = ? AND ${NOT_ART_SERIES}`));

function runFts(query: string, limit = 20): CardRow[] {
	try {
		return ftsStmt().all(query, limit) as CardRow[];
	} catch {
		return []; // FTS syntax error on odd OCR input — treat as no match
	}
}

/** FTS5 term for a word: quoted so punctuation can't break the query, prefix-matched. */
const term = (w: string) => `"${w.replace(/"/g, '')}"*`;

/**
 * Resolve a card by its (probably OCR'd) name. Tries cheapest paths first:
 * exact match → FTS5 prefix match on all words (indexed) → substring LIKE →
 * two OCR-tolerant fallbacks restricted to the name column:
 *  - any word (OR): junk glued to a good name ("Nobody ol", "Negate Has") no
 *    longer hides the card, because the AND query required every word to match;
 *  - word stems (first 4 letters of words with 5+ letters, OR): a single
 *    misread letter inside a word ("Tendcrize", "Comesiibisl") still reaches
 *    the right candidates. The caller ranks candidates by string similarity
 *    and applies its own acceptance threshold, so a wide net here is safe.
 */
export function searchByName(query: string): SearchResult {
	const cleaned = query.trim();
	if (cleaned.length < 2) return { results: [], matchType: 'none' };

	const exact = exactStmt().all(cleaned, `${cleaned} //%`, cleaned) as CardRow[];
	if (exact.length > 0) return { results: exact, matchType: 'exact' };

	const words = cleaned
		.replace(/['"]/g, '')
		.split(/\s+/)
		.filter((w) => w.length >= 2);
	if (words.length > 0) {
		const fts = runFts(words.map(term).join(' '));
		if (fts.length > 0) return { results: fts, matchType: 'fts' };
	}

	const like = likeStmt().all(`%${cleaned}%`) as CardRow[];
	if (like.length > 0) return { results: like, matchType: 'like' };

	// OCR-tolerant fallbacks. Every index-based path contributes its rows to one
	// pool; the distinct names in the pool are then ranked by the same
	// similarity the scanner applies and the best few come back with their
	// printings. Formerly the first path with any hit answered on its own, and
	// its 20 newest rows could all be printings of the wrong names while the
	// right one sat beyond the cut ("Escave Tunnel" -> Ice Tunnel, Escape Tunnel
	// never in the list; "Lomsern flare" -> a scene-box record, Lantern Flare
	// missing). The edit-distance scan over every name runs only when the
	// pool has nothing convincing, because it costs tens of milliseconds.
	const pool: CardRow[] = [];
	// Words that can carry a name: 3+ letters with a vowel (drops "ol", "TT").
	const strong = [...new Set(words.filter((w) => w.length >= 3 && /[aeiouy]/i.test(w)))];
	if (strong.length > 0) {
		pool.push(...runFts(`name : (${strong.map(term).join(' OR ')})`, FUZZY_ROWS));

		const stems = [...new Set(strong.filter((w) => w.length >= 5).map((w) => w.slice(0, 4)))];
		if (stems.length > 0) pool.push(...runFts(`name : (${stems.map(term).join(' OR ')})`, FUZZY_ROWS));

		// Word core: OCR glues the mana symbol or the frame edge to the first
		// letter ("CTenderize") or misreads it ("Jrenderize"), which defeats
		// prefix stems. Drop the first one or two characters and the last one
		// and look for the remaining core inside a name.
		for (const w of strong.filter((x) => x.length >= 7)) {
			const core = w.length >= 8 ? w.slice(2, -1) : w.slice(1, -1);
			pool.push(...(coreStmt().all(`%${core}%`) as CardRow[]));
		}
	}
	let ranked = rankNameMatches(pool, cleaned, FUZZY_NAMES);

	// Edit-distance search over every distinct name (and face): several
	// misread letters inside one word ("wmotorion" for Immolation) defeat the
	// index-based paths; a scan of ~38k names with a bigram prefilter takes a
	// few tens of milliseconds.
	if (ranked.length === 0 || ranked[0].score < 0.6) {
		const fuzzy = fuzzyNames(cleaned);
		if (fuzzy.length > 0) {
			pool.push(...fuzzy.flatMap((f) => exactStmt().all(f.name, `${f.name} //%`, f.name) as CardRow[]));
			ranked = rankNameMatches(pool, cleaned, FUZZY_NAMES);
		}
	}
	if (ranked.length === 0) return { results: [], matchType: 'none' };
	return { results: ranked.flatMap((m) => printingsByName(m.name).slice(0, ROWS_PER_NAME)), matchType: 'fuzzy' };
}

type NameEntry = { name: string; norm: string; bigrams: Set<string> };
let nameIndex: { cardCount: number; entries: NameEntry[] } | null = null;

function bigramsOf(norm: string): Set<string> {
	const out = new Set<string>();
	const compact = norm.replace(/\s+/g, ' ');
	for (let i = 0; i < compact.length - 1; i++) out.add(compact.slice(i, i + 2));
	return out;
}

/** Distinct canonical names with their aliases, rebuilt when the card count changes (imports). */
function nameEntries(): NameEntry[] {
	const cardCount = (sqlite.prepare('SELECT COUNT(*) AS c FROM cards').get() as { c: number }).c;
	if (nameIndex && nameIndex.cardCount === cardCount) return nameIndex.entries;
	const entries: NameEntry[] = [];
	for (const { name } of sqlite.prepare(`SELECT DISTINCT name FROM cards WHERE ${NOT_ART_SERIES}`).all() as Array<{ name: string }>) {
		for (const alias of nameAliases(name)) {
			const norm = normalizeName(alias);
			if (norm.length >= 3) entries.push({ name, norm, bigrams: bigramsOf(norm) });
		}
	}
	nameIndex = { cardCount, entries };
	return entries;
}

/**
 * Canonical names whose normalised form (or a face) is within edit-distance
 * similarity >= 0.5 of the query, best first, at most `limit`. Queries with
 * fewer than six letters are too short for this to mean anything.
 */
export function fuzzyNames(query: string, limit = 5): Array<{ name: string; score: number }> {
	const norm = normalizeName(query);
	if (norm.replace(/\s/g, '').length < 6) return [];
	const qb = bigramsOf(norm);
	const best = new Map<string, number>();
	for (const e of nameEntries()) {
		let inter = 0;
		for (const b of qb) if (e.bigrams.has(b)) inter++;
		if ((2 * inter) / (qb.size + e.bigrams.size) < 0.25) continue;
		const score = similarity(norm, e.norm);
		if (score >= 0.5 && score > (best.get(e.name) ?? 0)) best.set(e.name, score);
	}
	return [...best.entries()].map(([name, score]) => ({ name, score })).sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Every printing of a canonical card name, newest first (no date cut-off). */
export function printingsByName(name: string): CardRow[] {
	return printingsStmt().all(name) as CardRow[];
}

/**
 * Printings of a set whose collector number is one OCR error away from the
 * read one — one substituted digit, one dropped digit, one inserted digit —
 * restricted to the printed rarity letter when one was read. Feeds the
 * scanner's "could be …" suggestion for cards whose name is unreadable;
 * never an identification on its own.
 */
export function nearBySetNumber(setCode: string, collectorNumber: string, rarityLetter = ''): CardRow[] {
	const lc = setCode.trim().toLowerCase();
	const n = collectorNumber.trim().toLowerCase().replace(/^0+(?=\d)/, '');
	const m = /^(\d{1,4})([a-z]?)$/.exec(n);
	if (!lc || !m) return [];
	const [, digits, suffix] = m;
	const variants = new Set<string>();
	for (let i = 0; i < digits.length; i++) {
		for (const d of '0123456789') if (d !== digits[i]) variants.add(digits.slice(0, i) + d + digits.slice(i + 1));
		if (digits.length > 1) variants.add(digits.slice(0, i) + digits.slice(i + 1));
	}
	for (let i = 0; i <= digits.length; i++) for (const d of '0123456789') variants.add(digits.slice(0, i) + d + digits.slice(i));
	const numbers = [...variants].map((v) => v.replace(/^0+(?=\d)/, '')).filter((v) => v !== digits).map((v) => v + suffix);
	if (numbers.length === 0) return [];
	const rows = sqlite.prepare(`SELECT ${selectFields} FROM cards WHERE set_code = ? AND collector_number IN (${numbers.map(() => '?').join(',')}) AND ${NOT_ART_SERIES}`).all(lc, ...numbers) as CardRow[];
	const letter = rarityLetter.trim().toLowerCase();
	if (!letter) return rows;
	const wanted: Record<string, string[]> = { c: ['common'], u: ['uncommon'], r: ['rare'], m: ['mythic'], l: ['common'], s: ['special', 'bonus'] };
	const ok = wanted[letter];
	return ok ? rows.filter((r) => ok.includes(String(r.rarity ?? '').toLowerCase())) : rows;
}

/** Whether a set code exists in the database (used to weigh footer readings). */
export function isKnownSet(setCode: string): boolean {
	const lc = setCode.trim().toLowerCase();
	return lc.length > 0 && setsCache.get().some((s) => s.set_code === lc);
}

/**
 * Resolve a card by set code + collector number. Tries the raw number, then
 * zero-stripped, then zero-padded to 3 digits to tolerate the variations
 * seen in OCR output and print runs.
 */
export function searchBySetNumber(setCode: string, collectorNumber: string): SearchResult {
	const lc = setCode.toLowerCase();
	let results = setNumStmt().all(lc, collectorNumber) as CardRow[];
	if (results.length === 0) {
		const stripped = collectorNumber.replace(/^0+/, '');
		if (stripped !== collectorNumber) results = setNumStmt().all(lc, stripped) as CardRow[];
	}
	if (results.length === 0) {
		const padded = collectorNumber.padStart(3, '0');
		if (padded !== collectorNumber) results = setNumStmt().all(lc, padded) as CardRow[];
	}
	if (results.length === 0 && /[a-z]$/i.test(collectorNumber)) {
		// Variant suffix (e.g. "291a") that the set may not actually use — retry
		// the bare number so suffixed and plain printings both resolve.
		const noSuffix = collectorNumber.replace(/[a-z]$/i, '');
		if (noSuffix) results = setNumStmt().all(lc, noSuffix) as CardRow[];
	}
	if (results.length > 0) return { results, matchType: 'exact' };

	// OCR confuses similar glyphs in the set code (IMT/THT for TMT, MlD for
	// MID). When the code is unknown, try every known code one substitution
	// away; accept only if exactly one of them has this collector number.
	const known = new Set(setsCache.get().map((s) => s.set_code));
	if (!known.has(lc) && /^[a-z0-9]{3,4}$/.test(lc)) {
		const near = [...known].filter((code) => code.length === lc.length && oneSubstitutionApart(code, lc));
		const hits = near
			.map((code) => searchBySetNumberExact(code, collectorNumber))
			.filter((rows) => rows.length > 0);
		if (hits.length === 1) return { results: hits[0], matchType: 'fuzzy' };
	}
	return { results: [], matchType: 'none' };
}

function oneSubstitutionApart(a: string, b: string): boolean {
	let diff = 0;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) return false;
	return diff === 1;
}

/** Raw / zero-stripped / zero-padded lookups for one set code, no fuzzing. */
function searchBySetNumberExact(lc: string, collectorNumber: string): CardRow[] {
	let rows = setNumStmt().all(lc, collectorNumber) as CardRow[];
	if (rows.length === 0) {
		const stripped = collectorNumber.replace(/^0+/, '');
		if (stripped !== collectorNumber) rows = setNumStmt().all(lc, stripped) as CardRow[];
	}
	if (rows.length === 0) {
		const padded = collectorNumber.padStart(3, '0');
		if (padded !== collectorNumber) rows = setNumStmt().all(lc, padded) as CardRow[];
	}
	return rows;
}
