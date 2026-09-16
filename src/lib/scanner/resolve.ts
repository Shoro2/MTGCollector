/**
 * Evidence fusion for one scanned card.
 *
 * The OCR phases produce evidence, never decisions: name candidates with
 * scores from every name pass, and one collector-line reading per footer
 * variant (4x / 2x strip, both orientations, Google Vision). This module turns
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
import { nameScore, realWordCount } from './similarity';
import { disambiguateReprints, normalizeCollectorNumber } from './pipeline';

export type DecisionState = 'confirmed' | 'likely' | 'unknown' | 'conflict';
export type NameCandidate = { name: string; score: number; pass: string };
export type FooterReading = CollectorInfo & {
	/** Which crop produced the reading: 'primary', 'small', 'rotated', 'rotated small', 'vision'. */
	variant: string;
	/** Whether the reading's foil hint comes from an engine that tells ★ from • (Vision). */
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
};
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
/** A candidate this strong that names a different card vetoes a number-only hit ... */
export const NAME_EVIDENCE = 0.45;
/** ... when the hit itself scores below this against the OCR text. */
export const NAME_CONTRADICT = 0.3;

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

const isStructural = (s: CollectorInfo['numberSource']) => s === 'fraction' || s === 'pair' || s === 'rarity' || s === 'padded';

export function resolveCard(input: ResolveInput): Decision {
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

	// 1. A confident name identifies the card; the footer only picks the printing.
	if (best && best.score >= NAME_CONFIRM) {
		const printings = input.printingsByName(best.name);
		reasons.push(`name "${best.name}" ${best.score.toFixed(2)} (${best.pass}), ${printings.length} printing(s)`);
		if (printings.length === 1) return done(best.name, 'confirmed', printings[0], printings, 'confirmed');
		for (const { r, strength } of ranked) {
			if (strength === 'none') continue;
			const { match, log } = disambiguateReprints(printings, r.text, r.setCode, r.collectorNumber, r.numberSource);
			for (const l of log) reasons.push(`[${r.variant}] ${l}`);
			if (match) return done(best.name, 'confirmed', match, printings, 'confirmed');
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
		return done(best.name, 'confirmed', null, printings, printings.length > 0 ? 'unknown' : 'unknown');
	}

	// 2. Join: a partial name and a partial number that agree on exactly one printing.
	if (best && best.score >= NAME_LIKELY) {
		const printings = input.printingsByName(best.name);
		const setHints = new Set<string>();
		for (const { r } of ranked) if (r.setCode && input.isKnownSet(r.setCode)) setHints.add(r.setCode.toLowerCase());
		if (setHints.size === 0 && input.majoritySet) setHints.add(input.majoritySet.toLowerCase());
		const hits = printings.filter((row) => {
			if (setHints.size > 0 && !setHints.has(String(row.set_code).toLowerCase())) return false;
			const contributing = ranked.filter(({ r }) => r.collectorNumber && numberCompatible(r.collectorNumber, String(row.collector_number)));
			return contributing.length > 0 && contributing.every(({ r }) => rarityAgrees(r.rarity, row.rarity));
		});
		if (hits.length === 1) {
			const row = hits[0];
			// Two independent signals that agree *exactly* — the number read as
			// printed, from a strip whose set code is real or whose card exists
			// in one set only — confirm the printing; a number that is merely
			// compatible (one edit, dropped digit) stays a one-tap offer.
			const exact = ranked.find(({ r }) => r.collectorNumber && normalizeCollectorNumber(r.collectorNumber) === normalizeCollectorNumber(String(row.collector_number)) && isStructural(r.numberSource));
			const singleSet = new Set(printings.map((p) => String(p.set_code).toLowerCase())).size === 1;
			const setRead = exact !== undefined && exact.r.setCode !== '' && input.isKnownSet(exact.r.setCode) && exact.r.setCode.toLowerCase() === String(row.set_code).toLowerCase();
			if (exact && (setRead || singleSet)) {
				reasons.push(`join: name "${best.name}" ${best.score.toFixed(2)} + exact number from [${exact.r.variant}] -> ${row.set_code}#${row.collector_number}, confirmed`);
				return done(best.name, 'confirmed', row, hits, 'confirmed');
			}
			reasons.push(`join: name "${best.name}" ${best.score.toFixed(2)} + compatible number -> ${row.set_code}#${row.collector_number}`);
			return done(best.name, 'likely', row, hits, 'likely');
		}
		if (hits.length > 1) reasons.push(`join: ${hits.length} printings of "${best.name}" compatible, not unique`);
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
		const printings = input.printingsByName(best.name);
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
