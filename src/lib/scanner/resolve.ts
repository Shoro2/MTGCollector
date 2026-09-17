/**
 * Evidence fusion for one scanned card.
 *
 * The OCR phases produce evidence, never decisions: name candidates with
 * scores from every name pass, and one collector-line reading per footer
 * variant (4x / 2x strip, both orientations). This module turns
 * them into an identity decision and a printing decision, each with a state:
 *
 *   confirmed  the evidence singles out the card / printing
 *   likely     two weak signals agree on exactly one printing (one tap to accept)
 *   unknown    nothing reliable; a suggestion may be attached for the search
 *   conflict   a strong name and a strong footer reading name different cards
 *
 * Pure: database rows come in through `printingsByName` / `lookup` (prefetched
 * by the caller), so the rules are unit-testable without OCR or a browser.
 */
import type { CollectorInfo } from './parse';
import { bestAlias, nameAliases, nameScore, normalizeName, realWordCount, similarity } from './similarity';
import { disambiguateReprints, normalizeCollectorNumber } from './pipeline';
import { hammingDistance } from './phash';

export type DecisionState = 'confirmed' | 'likely' | 'unknown' | 'conflict';
export type NameCandidate = { name: string; score: number; pass: string };
export type FooterReading = CollectorInfo & {
	/** Which crop produced the reading: 'primary', 'small', 'rotated', 'rotated small'. */
	variant: string;
	/** Whether the reading's foil hint comes from an engine that tells ★ from •. None in use does (Tesseract cannot; the Google Vision retry that could is gone), so this is false everywhere today. */
	trustFoil: boolean;
	text: string;
};
export type PrintingRow = Record<string, unknown>;
export type Finish = 'nonfoil' | 'foil' | 'unknown';
export type ResolveInput = {
	nameCandidates: NameCandidate[];
	/** The most informative name OCR text (for contradiction checks and logging). */
	nameText: string;
	footer: FooterReading[];
	/** Set most identified cards of the same scan belong to, when there is a clear majority. */
	majoritySet: string | null;
	printingsByName: (name: string) => PrintingRow[];
	/** Set+number lookup incl. the server's one-substitution set correction; [] when unknown. */
	lookup: (setCode: string, collectorNumber: string) => PrintingRow[];
	/** Printings one OCR error away from the read number (rarity-filtered when a letter was read); optional. */
	nearLookup?: (setCode: string, collectorNumber: string, rarity: string) => PrintingRow[];
	isKnownSet: (setCode: string) => boolean;
	/** Printings whose reference art hash lies within ART_LIKELY bits of the warped card's art (Phase 3); optional. */
	artMatches?: ArtMatch[];
	/** The warped card's own art hashes (upright and 180°-rotated), to measure every printing of a name against; optional. */
	artHash?: string;
	artHashAlt?: string;
};
/** One art-hash hit: a printing (or a back face of it) and its Hamming distance to the scanned art. */
export type ArtMatch = { row: PrintingRow; distance: number; rotated?: boolean; face?: number };
export type Decision = {
	identity: { name: string | null; state: DecisionState; score: number };
	printing: { row: PrintingRow | null; candidates: PrintingRow[]; state: DecisionState };
	finish: Finish;
	language: string;
	reasons: string[];
};

/** A name candidate at or above this score identifies the card on its own. */
export const NAME_CONFIRM = 0.6;
/** From this score on a name candidate counts as evidence that can be joined with a footer reading. */
export const NAME_LIKELY = 0.4;
/**
 * From this score on a name identifies the card regardless of what the footer
 * says about other cards; below it the name is *uncertain* and the footer and
 * close runner-up candidates get a say. Every wrong name the full card pool
 * produced on the development photos scored 0.75 or less; a capitalised
 * showcase name read at 0.85 needs no further evidence.
 */
export const NAME_CERTAIN = 0.8;
/** A runner-up candidate within this distance of an uncertain best name makes the identity a one-tap choice. */
export const NAME_MARGIN = 0.1;
/** A candidate this strong that names a different card vetoes a number-only hit ... */
export const NAME_EVIDENCE = 0.45;
/** ... when the hit itself scores below this against the OCR text. */
export const NAME_CONTRADICT = 0.3;
/** An art hash this close (bits) is the same artwork: the same picture across printings measured 0-12, different pictures 26+. */
export const ART_CONFIRM = 10;
/**
 * An artwork match this close identifies a card with no other evidence. From
 * here up to ART_CONFIRM the match needs support — a name candidate for the
 * same card, or a footer reading that fits one of its printings. On a phone
 * (2026-09-17) a 10-bit match of the *rotated* hash confirmed "Caduceus, Staff
 * of Hermes" for a Rabid Attack whose name bar was unreadable, although the
 * footer had read its number, 96, correctly and Caduceus is #2 / #173. With
 * 114k references and two hashes per card a chance match at 10 bits is not
 * rare enough to stand alone; on the measured photos every art-only
 * confirmation that mattered sat at 4-6 bits.
 */
export const ART_CONFIRM_ALONE = 6;
/**
 * Up to this distance the artwork counts as evidence that a name candidate can
 * corroborate (and the server's search radius). Measured against 8.5k hashes:
 * the nearest artwork was the right card at 2–12 bits in every case and a
 * different card in 7 of 12 cases at 14 bits, so 14 is out.
 */
export const ART_LIKELY = 12;
/** A second artwork within this many bits of the best makes the art channel ambiguous. */
export const ART_MARGIN = 4;
/**
 * Printings of a name whose reference art lies this many bits further from
 * the scan than the name's nearest printing carry a different artwork and
 * leave the printing candidates (`artPool`). Measured on the eight photos:
 * same-artwork reprints and variants sit 0–8 bits behind the nearest printing
 * (MID vs Double Feature, regular vs extended frame), different artwork
 * 20–36 bits behind.
 */
export const ART_SAME_GAP = 16;

const HASH_HEX = /^[0-9a-f]{16}$/;

/** Hamming distance from the scanned card (upright or rotated hash) to a printing's reference art; null without hashes on either side. */
function artDistance(row: PrintingRow, hash?: string, alt?: string): number | null {
	const ref = typeof row.art_hash === 'string' && HASH_HEX.test(row.art_hash) ? row.art_hash : null;
	if (!ref) return null;
	let best: number | null = null;
	for (const h of [hash, alt]) {
		if (!h || !HASH_HEX.test(h)) continue;
		const d = hammingDistance(h, ref);
		if (best === null || d < best) best = d;
	}
	return best;
}

/**
 * The printings of a name that can be the scanned card by their artwork. When
 * the nearest reference art is a close match (≤ ART_CONFIRM), printings more
 * than ART_SAME_GAP bits further away show a different artwork and drop out;
 * printings without a hash always stay (the index may be incomplete). Without
 * a close match, or without hashes, every printing stays: the hash can only
 * rule a printing *out* when it has clearly recognised the artwork.
 */
export function artPool(printings: PrintingRow[], hash?: string, alt?: string): PrintingRow[] {
	const distances = printings.map((r) => artDistance(r, hash, alt));
	let best: number | null = null;
	for (const d of distances) if (d !== null && (best === null || d < best)) best = d;
	if (best === null || best > ART_CONFIRM) return printings;
	const limit = best + ART_SAME_GAP;
	return printings.filter((_, i) => distances[i] === null || (distances[i] as number) <= limit);
}

type Strength = 'strong' | 'medium' | 'weak' | 'none';
const STRENGTH_ORDER: Record<Strength, number> = { strong: 0, medium: 1, weak: 2, none: 3 };

/** Scryfall rarity -> letter printed on the card. Basic lands print "L" but carry rarity "common". */
const RARITY_LETTER: Record<string, string> = { common: 'c', uncommon: 'u', rare: 'r', mythic: 'm', special: 's', bonus: 's' };

export function rarityAgrees(letter: string, rarity: unknown): boolean {
	const expected = RARITY_LETTER[String(rarity ?? '').toLowerCase()];
	if (!letter || !expected || letter === expected) return true;
	return letter === 'l' && expected === 'c';
}

/**
 * Whether an OCR'd collector number could be the printed one: equal, one
 * substituted digit at equal length, or one dropped digit ("80" for 180).
 */
export function numberCompatible(read: string, actual: string): boolean {
	const a = normalizeCollectorNumber(read);
	const b = normalizeCollectorNumber(actual);
	if (!a || !b) return false;
	if (a === b) return true;
	if (a.length === b.length) {
		let diff = 0;
		for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) return false;
		return diff === 1;
	}
	if (a.length === b.length - 1) {
		for (let i = 0; i < b.length; i++) if (b.slice(0, i) + b.slice(i + 1) === a) return true;
	}
	return false;
}

/** Number sources that come from a parsed collector-line structure rather than a stray digit run. */
export const isStructural = (s: CollectorInfo['numberSource']) => s === 'fraction' || s === 'pair' || s === 'rarity' || s === 'padded';

/** Names (or faces) shorter than this, normalised, only identify a card when read exactly. */
const SHORT_NAME = 6;

/**
 * Whether a name candidate identifies the card on its own. Measured against
 * the full card pool (~38k names, tokens included), a bare score threshold
 * confirmed "Boa" as the token Boar, "Cal" as Beck // Call and "Easy Te" as
 * Easy Prey: a 40% edit budget is a single letter on a four-letter name, and
 * an OCR text without one real word matches *something* in a pool that size.
 * So the score must clear NAME_CONFIRM, a short name or face needs an exact
 * read, and below NAME_CERTAIN the text must contain at least one real word.
 */
export function nameIdentifies(candidate: { name: string; score: number }, nameText: string): boolean {
	if (candidate.score < NAME_CONFIRM) return false;
	const { alias } = bestAlias(nameText, candidate.name);
	if (normalizeName(alias).length < SHORT_NAME && candidate.score < 0.999) return false;
	return candidate.score >= NAME_CERTAIN || realWordCount(nameText) > 0;
}

export function resolveCard(input: ResolveInput): Decision {
	// Every printings lookup of the fusion sees the name's printings narrowed
	// by the scanned artwork (artPool); logged once per name.
	const narrowedNames = new Set<string>();
	const printingsOf = (name: string): PrintingRow[] => {
		const all = input.printingsByName(name);
		const pool = artPool(all, input.artHash, input.artHashAlt);
		if (pool.length < all.length && !narrowedNames.has(name)) {
			narrowedNames.add(name);
			reasons.push(`art: "${name}" narrowed to ${pool.length} of ${all.length} printing(s) by artwork`);
		}
		return pool;
	};
	const reasons: string[] = [];
	const readings = input.footer.filter((r) => r.setCode || r.collectorNumber);
	const keyOf = (r: FooterReading) => `${r.setCode.toLowerCase()}|${normalizeCollectorNumber(r.collectorNumber)}`;
	const consensus = new Map<string, number>();
	for (const r of readings) consensus.set(keyOf(r), (consensus.get(keyOf(r)) ?? 0) + 1);
	// Strength of a reading: a structural number with a known set is strong, a
	// structural number without one medium, anything else weak; two variants
	// agreeing on the same set+number lift it one level.
	const strengthOf = (r: FooterReading): Strength => {
		if (!r.collectorNumber) return 'none';
		let s: Strength = isStructural(r.numberSource) ? (r.setCode && input.isKnownSet(r.setCode) ? 'strong' : 'medium') : 'weak';
		if ((consensus.get(keyOf(r)) ?? 1) >= 2 && s !== 'strong') s = s === 'weak' ? 'medium' : 'strong';
		return s;
	};
	const ranked = readings
		.map((r) => ({ r, strength: strengthOf(r) }))
		.sort((a, b) => STRENGTH_ORDER[a.strength] - STRENGTH_ORDER[b.strength]);
	const best = [...input.nameCandidates].sort((a, b) => b.score - a.score)[0] ?? null;
	const language = readings.find((r) => r.language)?.language ?? '';
	const trusted = input.footer.filter((r) => r.trustFoil && (r.setCode || r.collectorNumber));
	const finish: Finish = trusted.length === 0 ? 'unknown' : trusted.some((r) => r.foilFromText) ? 'foil' : 'nonfoil';
	const done = (name: string | null, identityState: DecisionState, row: PrintingRow | null, candidates: PrintingRow[], printingState: DecisionState): Decision => ({
		identity: { name, state: identityState, score: best?.score ?? 0 },
		printing: { row, candidates, state: printingState },
		finish,
		language,
		reasons
	});
	const agrees = (row: PrintingRow) => nameScore(input.nameText, String(row.name)) >= NAME_LIKELY || (best !== null && best.name === row.name && best.score >= NAME_LIKELY);

	// A number-only hit is plausible unless the printed rarity letter or real
	// name evidence contradicts it.
	const plausible = (row: PrintingRow, r: FooterReading): boolean => {
		const label = `${r.setCode || '?'}#${r.collectorNumber} -> "${row.name}"`;
		if (!rarityAgrees(r.rarity, row.rarity)) {
			reasons.push(`[${r.variant}] ${label} is ${row.rarity} but the line reads "${r.rarity.toUpperCase()}", rejected`);
			return false;
		}
		const hitScore = nameScore(input.nameText, String(row.name));
		if (best && best.score >= NAME_EVIDENCE && best.name !== row.name && hitScore < NAME_CONTRADICT) {
			reasons.push(`[${r.variant}] ${label} rejected: name OCR points at "${best.name}" (${best.score.toFixed(2)})`);
			return false;
		}
		if (r.numberSource === 'weak' && realWordCount(input.nameText) > 0 && hitScore < NAME_CONTRADICT) {
			reasons.push(`[${r.variant}] ${label} (weak number) contradicts name OCR "${input.nameText}", rejected`);
			return false;
		}
		return true;
	};

	// Join: the printings of a candidate that the footer is compatible with —
	// in the read set (or the majority set when no set was read), with a number
	// within one edit of some reading whose rarity letter agrees.
	const setHints = new Set<string>();
	for (const { r } of ranked) if (r.setCode && input.isKnownSet(r.setCode)) setHints.add(r.setCode.toLowerCase());
	if (setHints.size === 0 && input.majoritySet) setHints.add(input.majoritySet.toLowerCase());
	const joinHits = (name: string): PrintingRow[] =>
		printingsOf(name).filter((row) => {
			if (setHints.size > 0 && !setHints.has(String(row.set_code).toLowerCase())) return false;
			const contributing = ranked.filter(({ r }) => r.collectorNumber && numberCompatible(r.collectorNumber, String(row.collector_number)));
			return contributing.length > 0 && contributing.every(({ r }) => rarityAgrees(r.rarity, row.rarity));
		});
	const sameNumber = (r: FooterReading, row: PrintingRow) => r.collectorNumber !== '' && normalizeCollectorNumber(r.collectorNumber) === normalizeCollectorNumber(String(row.collector_number));
	// A partial name and a partial number that agree on exactly one printing.
	// Two independent signals that agree *exactly* — the number read as printed,
	// from a strip whose set code is real or whose card exists in one set only —
	// confirm the printing; a number that is merely compatible (one edit, dropped
	// digit) stays a one-tap offer.
	const joinDecision = (cand: NameCandidate): Decision | null => {
		const hits = joinHits(cand.name);
		if (hits.length > 1) reasons.push(`join: ${hits.length} printings of "${cand.name}" compatible, not unique`);
		if (hits.length !== 1) return null;
		const row = hits[0];
		const exact = ranked.find(({ r }) => sameNumber(r, row) && isStructural(r.numberSource));
		const singleSet = new Set(printingsOf(cand.name).map((p) => String(p.set_code).toLowerCase())).size === 1;
		const setRead = exact !== undefined && exact.r.setCode !== '' && input.isKnownSet(exact.r.setCode) && exact.r.setCode.toLowerCase() === String(row.set_code).toLowerCase();
		if (exact && (setRead || singleSet)) {
			reasons.push(`join: name "${cand.name}" ${cand.score.toFixed(2)} + exact number from [${exact.r.variant}] -> ${row.set_code}#${row.collector_number}, confirmed`);
			return done(cand.name, 'confirmed', row, hits, 'confirmed');
		}
		reasons.push(`join: name "${cand.name}" ${cand.score.toFixed(2)} + compatible number -> ${row.set_code}#${row.collector_number}`);
		return done(cand.name, 'likely', row, hits, 'likely');
	};
	// Readings with a real set code that a name has no printing in — or, for a
	// structural number, no printing within one edit of it there.
	const contradictingReadings = (name: string): FooterReading[] => {
		const printings = printingsOf(name);
		return ranked
			.filter(({ r, strength }) => {
				if (!r.setCode || !input.isKnownSet(r.setCode)) return false;
				const inSet = printings.filter((p) => String(p.set_code).toLowerCase() === r.setCode.toLowerCase());
				if (inSet.length === 0) return true;
				if (!r.collectorNumber || strength === 'weak' || strength === 'none') return false;
				return !inSet.some((p) => numberCompatible(r.collectorNumber, String(p.collector_number)));
			})
			.map(({ r }) => r);
	};
	// Cards a structural reading points at exactly (read set, or the majority
	// set when the set code was unreadable), plausible and not the best name.
	const footerAlternatives = (): Array<{ row: PrintingRow; r: FooterReading; strength: Strength; viaMajority: boolean }> => {
		const out: Array<{ row: PrintingRow; r: FooterReading; strength: Strength; viaMajority: boolean }> = [];
		for (const { r, strength } of ranked) {
			if (strength !== 'strong' && strength !== 'medium') continue;
			let rows = r.setCode ? input.lookup(r.setCode, r.collectorNumber) : [];
			let viaMajority = false;
			if (rows.length === 0 && input.majoritySet && (!r.setCode || !input.isKnownSet(r.setCode))) {
				rows = input.lookup(input.majoritySet, r.collectorNumber);
				viaMajority = rows.length > 0;
			}
			const ok = rows.filter((row) => (best === null || String(row.name) !== best.name) && plausible(row, r));
			if (ok.length === 1) out.push({ row: ok[0], r, strength, viaMajority });
		}
		return out;
	};
	const byScore = [...input.nameCandidates].sort((a, b) => b.score - a.score);

	// 0. Art-hash evidence (Phase 3): the artwork of the warped card against the
	// reference hashes. Independent of OCR and the strongest identity signal
	// when one artwork stands out; useless for the printing among reprints of
	// the same picture, which stays the footer's job.
	const artByName = new Map<string, { name: string; distance: number; rows: PrintingRow[] }>();
	for (const m of [...(input.artMatches ?? [])].sort((a, b) => a.distance - b.distance)) {
		if (m.distance > ART_LIKELY) continue;
		const name = String(m.row.name);
		const g = artByName.get(name);
		if (g) g.rows.push(m.row);
		else artByName.set(name, { name, distance: m.distance, rows: [m.row] });
	}
	const artRanked = [...artByName.values()];
	const artBest = artRanked[0] ?? null;
	const artRunnerUp = artRanked[1] ?? null;
	const artUnambiguous = artBest !== null && (artRunnerUp === null || artRunnerUp.distance - artBest.distance >= ART_MARGIN);
	const artStrong = artBest !== null && artBest.distance <= ART_CONFIRM && artUnambiguous;
	// The printing of an art-identified card: the footer picks among the
	// name's printings (narrowed by artwork like every lookup, see artPool); a
	// single printing left needs no footer. The server's hits alone never
	// settle a printing — they are the printings within the search radius,
	// not every printing with this artwork (a same-art reprint can sit just
	// outside it: Lantern Flare VOW #23 was confirmed as the extended-art
	// #351 that way), so without the name's printings the printing stays open.
	const artPrinting = (g: { name: string; rows: PrintingRow[] }): { row: PrintingRow | null; candidates: PrintingRow[]; state: DecisionState } => {
		const pool = printingsOf(g.name);
		if (pool.length === 0) return { row: null, candidates: g.rows, state: 'unknown' };
		for (const { r, strength } of ranked) {
			if (strength === 'none') continue;
			const { match, log } = disambiguateReprints(pool, r.text, r.setCode, r.collectorNumber, r.numberSource);
			for (const l of log) reasons.push(`[${r.variant}] ${l}`);
			if (match) return { row: match, candidates: pool, state: 'confirmed' };
		}
		if (pool.length === 1) return { row: pool[0], candidates: pool, state: 'confirmed' };
		return { row: null, candidates: pool, state: 'unknown' };
	};
	if (artBest) reasons.push(`art: "${artBest.name}" ${artBest.distance} bits (${artBest.rows.length} printing(s) with this artwork)${artRunnerUp ? `, next "${artRunnerUp.name}" ${artRunnerUp.distance} bits` : ''}`);
	// What the footer says about an art-matched name. Only structurally parsed numbers count: equal
	// to one of the name's printings the footer agrees (so does a real set code the name was printed
	// in); compatible with none of them — not even one digit off — it contradicts.
	const artFooter = (name: string): 'agrees' | 'contradicts' | 'silent' => {
		const printings = printingsOf(name);
		if (printings.length === 0) return 'silent';
		const structural = ranked.filter(({ r }) => r.collectorNumber !== '' && isStructural(r.numberSource));
		if (structural.some(({ r }) => printings.some((p) => sameNumber(r, p)))) return 'agrees';
		if (ranked.some(({ r }) => r.setCode !== '' && input.isKnownSet(r.setCode) && printings.some((p) => String(p.set_code).toLowerCase() === r.setCode.toLowerCase()))) return 'agrees';
		if (structural.some(({ r }) => !printings.some((p) => numberCompatible(r.collectorNumber, String(p.collector_number))))) return 'contradicts';
		// In a spread the set most of the other cards belong to supports the match as well: a chance
		// match among 114k references lands in that one set about once in a hundred times.
		if (input.majoritySet && printings.some((p) => String(p.set_code).toLowerCase() === input.majoritySet!.toLowerCase())) return 'agrees';
		return 'silent';
	};
	// An art match the footer contradicts and no name supports is dropped for good (no one-tap offer either).
	let artIgnored = false;
	if (artStrong && artBest) {
		if (best && best.score >= NAME_CERTAIN && nameIdentifies(best, input.nameText) && best.name !== artBest.name) {
			reasons.push(`conflict: name says "${best.name}" ${best.score.toFixed(2)}, artwork says "${artBest.name}"`);
			return done(best.name, 'conflict', null, [...artBest.rows, ...printingsOf(best.name)], 'conflict');
		}
		const nameAgrees = byScore.find((c) => c.score >= NAME_LIKELY && c.name === artBest.name);
		const footer = artFooter(artBest.name);
		if (footer === 'contradicts' && !nameAgrees) {
			artIgnored = true;
			reasons.push(`art "${artBest.name}" ${artBest.distance} bits dropped: the footer's number fits none of its printings and no name supports it`);
		} else if (nameAgrees || footer === 'agrees' || artBest.distance <= ART_CONFIRM_ALONE) {
			const p = artPrinting(artBest);
			const why = nameAgrees ? `name agrees ${nameAgrees.score.toFixed(2)}` : footer === 'agrees' ? 'the footer or the majority set fits one of its printings' : `${artBest.distance} bits, close enough on its own`;
			reasons.push(`art identifies "${artBest.name}" (${why})`);
			return done(artBest.name, 'confirmed', p.row, p.candidates, p.state);
		} else {
			// 7-10 bits with nothing to support it: the name and footer rules go first, the
			// artwork stays a rival for an uncertain name (1d) and a one-tap offer at the end (3d).
			reasons.push(`art "${artBest.name}" ${artBest.distance} bits has no support from the name or the footer: not confirmed on its own`);
		}
	}
	const artRival = artStrong && artBest && !artIgnored ? artBest : null;
	// 0b. A looser or ambiguous artwork plus a name candidate naming the same
	// card: two independent channels agree.
	if (artBest) {
		const agreeing = byScore.find((c) => c.score >= NAME_LIKELY && artByName.has(c.name));
		if (agreeing) {
			const g = artByName.get(agreeing.name)!;
			const p = artPrinting(g);
			reasons.push(`art "${g.name}" ${g.distance} bits + name ${agreeing.score.toFixed(2)} (${agreeing.pass}) agree -> confirmed`);
			return done(g.name, 'confirmed', p.row, p.candidates, p.state);
		}
	}

	// 1. A name with enough evidence identifies the card; the footer picks the printing.
	if (best && nameIdentifies(best, input.nameText)) {
		const printings = printingsOf(best.name);
		reasons.push(`name "${best.name}" ${best.score.toFixed(2)} (${best.pass}), ${printings.length} printing(s)`);
		const certain = best.score >= NAME_CERTAIN;
		if (certain && printings.length === 1) return done(best.name, 'confirmed', printings[0], printings, 'confirmed');
		// The footer corroborates the name when it picks one of its printings. For
		// an uncertain name an *exact* structural number is required first; the
		// looser matches (set only, near set code, one digit off) only count once
		// no exact alternative fits the name text better — a footer that reads
		// "0074" exactly and names a card resembling the OCR text beats a name
		// at 0.63 whose printing is #76.
		const corroborated = (exactOnly: boolean): Decision | null => {
			for (const { r, strength } of ranked) {
				if (strength === 'none') continue;
				const { match, log } = disambiguateReprints(printings, r.text, r.setCode, r.collectorNumber, r.numberSource);
				if (!exactOnly) for (const l of log) reasons.push(`[${r.variant}] ${l}`);
				if (!match) continue;
				if (exactOnly && !(isStructural(r.numberSource) && sameNumber(r, match))) continue;
				if (exactOnly) reasons.push(`[${r.variant}] exact number ${r.setCode || '?'}#${r.collectorNumber} corroborates "${best.name}"`);
				return done(best.name, 'confirmed', match, printings, 'confirmed');
			}
			return null;
		};
		if (!certain) {
			const exact = corroborated(true);
			if (exact) return exact;
			// 1b. A structural reading that points exactly at another card which also
			// fits the name text: two agreeing signals against one uncertain one.
			for (const alt of footerAlternatives()) {
				const fit = nameScore(input.nameText, String(alt.row.name));
				if (fit < NAME_LIKELY) continue;
				const label = `[${alt.r.variant}] ${alt.strength} reading${alt.viaMajority ? ' via majority set' : ''} -> ${alt.row.set_code}#${alt.row.collector_number} "${alt.row.name}" fits the name text (${fit.toFixed(2)}) and beats the uncertain name "${best.name}" ${best.score.toFixed(2)}`;
				if (alt.strength === 'strong' && !alt.viaMajority) {
					reasons.push(`${label}, confirmed`);
					return done(String(alt.row.name), 'confirmed', alt.row, [alt.row], 'confirmed');
				}
				reasons.push(`${label}, likely`);
				return done(String(alt.row.name), 'likely', alt.row, [alt.row, ...printings], 'likely');
			}
		}
		const loose = corroborated(false);
		if (loose) return loose;
		if (!certain) {
			// 1c. The footer contradicts the name (a real set code it was never
			// printed in, or a structural number none of its printings match): a
			// lesser candidate that joins with the footer wins, otherwise one tap.
			const contradictions = contradictingReadings(best.name);
			if (contradictions.length > 0) {
				for (const cand of byScore) {
					if (cand.name === best.name || cand.score < NAME_LIKELY) continue;
					const joined = joinDecision(cand);
					if (joined) return joined;
				}
				reasons.push(`name "${best.name}" ${best.score.toFixed(2)} contradicted by ${contradictions.map((r) => `[${r.variant}] ${r.setCode}#${r.collectorNumber}`).join(', ')} -> likely`);
				return done(best.name, 'likely', printings.length === 1 ? printings[0] : null, printings, 'likely');
			}
			// 1d'. An unsupported close artwork that names another card: two uncertain
			// channels disagree, so nothing is confirmed. The artwork goes first — on the
			// measured photos it was right at up to 10 bits where names below 0.8 were not.
			if (artRival && artRival.name !== best.name) {
				reasons.push(`name "${best.name}" ${best.score.toFixed(2)} vs artwork "${artRival.name}" ${artRival.distance} bits: neither is supported -> likely`);
				return done(artRival.name, 'likely', artRival.rows.length === 1 ? artRival.rows[0] : null, [...artRival.rows, ...printings], 'likely');
			}
			// 1d. A runner-up candidate too close to call: offer both. Both are
			// measured on the whole name text, without the junk-tolerant prefix
			// rule: "W Courier of Cotesiiis" scores 0.65 against Aven Courier
			// once "of Cotesiiis" is written off as junk, but that word is exactly
			// the evidence for Courier of Comestibles; conversely "Ghoulish ro"
			// reaches Ghoulflesh only through the prefix "Ghoulish" (0.46 on the
			// whole text) while Ghoulish Procession reads 0.58 on the whole text.
			const plainScore = (name: string) => Math.max(...nameAliases(name).map((alias) => similarity(input.nameText, alias)));
			const bestPlain = Math.min(best.score, plainScore(best.name));
			const runnerUp = byScore.map((c) => ({ ...c, plain: plainScore(c.name) })).find((c) => c.name !== best.name && c.plain >= NAME_LIKELY && c.plain >= bestPlain - NAME_MARGIN);
			if (runnerUp) {
				reasons.push(`name "${best.name}" ${best.score.toFixed(2)} (${bestPlain.toFixed(2)} on the whole text) vs "${runnerUp.name}" ${runnerUp.plain.toFixed(2)}: too close to call -> likely`);
				return done(best.name, 'likely', printings.length === 1 ? printings[0] : null, [...printings, ...printingsOf(runnerUp.name)], 'likely');
			}
			if (printings.length === 1) return done(best.name, 'confirmed', printings[0], printings, 'confirmed');
		}
		// Two footer variants agreeing on a printing of a *different* card is a
		// conflict the user has to settle, not a coin toss.
		for (const { r, strength } of ranked) {
			if (strength !== 'strong' || (consensus.get(keyOf(r)) ?? 1) < 2) continue;
			const rows = input.lookup(r.setCode, r.collectorNumber).filter((row) => String(row.name) !== best.name);
			if (rows.length > 0) {
				reasons.push(`conflict: name says "${best.name}", footer ${r.setCode}#${r.collectorNumber} says "${rows[0].name}"`);
				return done(best.name, 'conflict', null, [...printings, ...rows], 'conflict');
			}
		}
		return done(best.name, 'confirmed', null, printings, 'unknown');
	}

	// 2. Join: a partial name and a partial number that agree on exactly one printing.
	if (best && best.score >= NAME_LIKELY) {
		const joined = joinDecision(best);
		if (joined) return joined;
	}

	// 3. Footer only, strongest reading first.
	for (const { r, strength } of ranked) {
		if (strength === 'none') continue;
		let rows = r.setCode ? input.lookup(r.setCode, r.collectorNumber) : [];
		let viaMajority = false;
		if (rows.length === 0 && input.majoritySet && (!r.setCode || !input.isKnownSet(r.setCode))) {
			rows = input.lookup(input.majoritySet, r.collectorNumber);
			viaMajority = rows.length > 0;
		}
		if (rows.length === 0) continue;
		const ok = rows.filter((row) => plausible(row, r));
		if (ok.length !== 1) {
			reasons.push(`[${r.variant}] ${r.setCode || input.majoritySet}#${r.collectorNumber}: ${rows.length} row(s), ${ok.length} plausible`);
			continue;
		}
		const row = ok[0];
		const nameAgrees = agrees(row);
		const via = viaMajority ? ' via majority set' : '';
		if (strength === 'strong' && !viaMajority) {
			reasons.push(`[${r.variant}] strong reading -> ${row.set_code}#${row.collector_number} "${row.name}"`);
			return done(String(row.name), 'confirmed', row, [row], 'confirmed');
		}
		if (nameAgrees) {
			reasons.push(`[${r.variant}] ${strength} reading${via} + name agreement -> ${row.set_code}#${row.collector_number} "${row.name}"`);
			return done(String(row.name), 'likely', row, [row], 'likely');
		}
		// A structural number is worth showing as a suggestion; a weak one only
		// when the name OCR at least faintly agrees — otherwise it is noise.
		if (strength !== 'weak' || nameScore(input.nameText, String(row.name)) >= NAME_CONTRADICT) {
			reasons.push(`[${r.variant}] ${strength} reading${via} without name agreement -> suggestion "${row.name}"`);
			return done(null, 'unknown', null, [row], 'unknown');
		}
		reasons.push(`[${r.variant}] weak reading${via} without any name agreement -> no suggestion ("${row.name}")`);
	}
	// 3d. Artwork alone, without a name or a footer to confirm it: one tap, the
	// printings with that picture (and the next artwork when it was close).
	// Only a close match: a looser one names a different card too often.
	if (artBest && artBest.distance <= ART_CONFIRM && !artIgnored) {
		const candidates = artUnambiguous ? artBest.rows : artRanked.flatMap((g) => g.rows);
		reasons.push(`art "${artBest.name}" ${artBest.distance} bits${artUnambiguous || !artRunnerUp ? '' : ` vs "${artRunnerUp.name}" ${artRunnerUp.distance}`} without other evidence -> likely`);
		return done(artBest.name, 'likely', artBest.rows.length === 1 && artUnambiguous ? artBest.rows[0] : null, candidates, 'likely');
	}
	// 4. Nothing resolved: a structural number one OCR error away from exactly
	// one printing of the read or majority set with the printed rarity letter
	// becomes a suggestion ("U 0223 THT" for #323 uncommon) — never more.
	if (input.nearLookup) {
		for (const { r, strength } of ranked) {
			if (strength === 'none' || !isStructural(r.numberSource)) continue;
			const setCode = r.setCode && input.isKnownSet(r.setCode) ? r.setCode : input.majoritySet;
			if (!setCode) continue;
			const rows = input.nearLookup(setCode, r.collectorNumber, r.rarity);
			if (rows.length >= 1 && rows.length <= 3) {
				const ranked = [...rows].sort((a, b) => nameScore(input.nameText, String(b.name)) - nameScore(input.nameText, String(a.name)));
				reasons.push(`[${r.variant}] ${setCode}#${r.collectorNumber} one digit off ${ranked.map((x) => `${x.set_code}#${x.collector_number} "${x.name}"`).join(', ')} (rarity ${r.rarity ? r.rarity.toUpperCase() + ' agrees' : 'not read'}) -> suggestion(s)`);
				return done(null, 'unknown', null, ranked, 'unknown');
			}
		}
	}
	// 5. A partial name that nothing corroborates is still worth one tap when
	// it has few printings (or few in the read / majority set).
	if (best && best.score >= NAME_LIKELY) {
		const printings = printingsOf(best.name);
		const setHints = new Set<string>();
		for (const { r } of ranked) if (r.setCode && input.isKnownSet(r.setCode)) setHints.add(r.setCode.toLowerCase());
		if (input.majoritySet) setHints.add(input.majoritySet.toLowerCase());
		const preferred = printings.filter((row) => setHints.has(String(row.set_code).toLowerCase()));
		const pick = (preferred.length > 0 ? preferred : printings).slice(0, 3);
		if (pick.length > 0) {
			reasons.push(`name candidate "${best.name}" ${best.score.toFixed(2)} (${best.pass}) without corroboration -> suggestion(s) ${pick.map((x) => `${x.set_code}#${x.collector_number}`).join(', ')}`);
			return done(null, 'unknown', null, pick, 'unknown');
		}
	}
	if (best) reasons.push(`best name candidate "${best.name}" ${best.score.toFixed(2)} below ${NAME_LIKELY}, no usable footer`);
	return done(null, 'unknown', null, [], 'unknown');
}
