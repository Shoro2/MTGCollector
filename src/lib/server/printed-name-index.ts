/**
 * Printed names of non-English printings — the DB-free part: extracting them
 * from a Scryfall card object (all-cards bulk) and matching OCR text against
 * them. The catalogue's names are English; a German card shows "Kriegshorn",
 * not "War Horn", and without these names the scanner could only identify it
 * by its footer or its artwork (phone session 2026-09-18).
 *
 * The import job (printed-names.ts) and the name search (card-search.ts) are
 * the DB-bound users; this module stays importable by unit tests.
 */
import { bigramsOf, normalizeName, similarity, type PrintedAlias } from '../scanner/similarity.js';

/** One printed name: the canonical English card name, the language, the name as printed. */
export type PrintedNameRow = { name: string; lang: string; printed: string };

/** The fields of a Scryfall card object the import reads. */
export type BulkCard = {
	name?: string;
	lang?: string;
	layout?: string;
	printed_name?: string;
	card_faces?: Array<{ name?: string; printed_name?: string }>;
};

/**
 * The printed names of one card object in the wanted languages: the card's own
 * `printed_name` and, for double-faced / split / adventure cards, each face's.
 * A printed name spelled like the English name or one of its faces adds
 * nothing and is skipped; art-series records are not cards.
 */
export function printedNameRows(card: BulkCard, langs: ReadonlySet<string>): PrintedNameRow[] {
	const name = card.name?.trim();
	const lang = card.lang?.trim().toLowerCase();
	if (!name || !lang || !langs.has(lang) || card.layout === 'art_series') return [];
	const english = new Set([name, ...name.split(' // ')].map(normalizeName));
	const out: PrintedNameRow[] = [];
	const add = (printed?: string) => {
		const p = printed?.trim();
		if (!p || english.has(normalizeName(p)) || out.some((o) => o.printed === p)) return;
		out.push({ name, lang, printed: p });
	};
	add(card.printed_name);
	for (const face of card.card_faces ?? []) add(face.printed_name);
	return out;
}

type Entry = { name: string; lang: string; alias: string; norm: string; bigrams: Set<string> };

/** Printed names of the catalogue in memory: aliases per English name, exact and edit-distance lookup. */
export class PrintedNameIndex {
	private readonly byName = new Map<string, PrintedAlias[]>();
	private readonly byNorm = new Map<string, Array<{ name: string; alias: string; lang: string }>>();
	private readonly entries: Entry[] = [];

	constructor(rows: Iterable<PrintedNameRow>) {
		for (const r of rows) {
			const aliases = this.byName.get(r.name) ?? [];
			if (aliases.some((a) => a.alias === r.printed && a.lang === r.lang)) continue;
			aliases.push({ alias: r.printed, lang: r.lang });
			this.byName.set(r.name, aliases);
			const norm = normalizeName(r.printed);
			if (norm.length < 3) continue;
			const same = this.byNorm.get(norm) ?? [];
			same.push({ name: r.name, alias: r.printed, lang: r.lang });
			this.byNorm.set(norm, same);
			this.entries.push({ name: r.name, lang: r.lang, alias: r.printed, norm, bigrams: bigramsOf(norm) });
		}
	}

	/** Number of distinct printed names. */
	get size(): number {
		return this.entries.length;
	}

	/** The printed names of a canonical English name. */
	aliasesOf(name: string): readonly PrintedAlias[] {
		return this.byName.get(name) ?? [];
	}

	/**
	 * English names whose printed name equals the query once both are normalised
	 * (accents folded: the OCR reads "Ausloschung" for "Auslöschung"), then — when
	 * nothing is equal — the printed names within edit-distance similarity `min`,
	 * best first. Queries with fewer than six letters only match exactly: a short
	 * text resembles too many of the ~30k German names.
	 */
	match(query: string, limit = 5, min = 0.6): Array<{ name: string; alias: string; lang: string; score: number }> {
		const norm = normalizeName(query);
		const exact = this.byNorm.get(norm);
		if (exact) return exact.slice(0, limit).map((e) => ({ ...e, score: 1 }));
		if (norm.replace(/\s/g, '').length < 6) return [];
		const qb = bigramsOf(norm);
		const best = new Map<string, { name: string; alias: string; lang: string; score: number }>();
		for (const e of this.entries) {
			let inter = 0;
			for (const b of qb) if (e.bigrams.has(b)) inter++;
			if ((2 * inter) / (qb.size + e.bigrams.size) < 0.25) continue;
			const score = similarity(norm, e.norm);
			if (score >= min && score > (best.get(e.name)?.score ?? 0)) best.set(e.name, { name: e.name, alias: e.alias, lang: e.lang, score });
		}
		return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
	}
}
