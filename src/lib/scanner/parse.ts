/**
 * Parse the collector-info line at the bottom of an MTG card.
 * Pure text-in / struct-out — no DOM or OpenCV dependency, so this is
 * easy to unit-test independently of the scanner UI.
 */

/** Fix common OCR misreads of digits (J/I/l/| → 1, O → 0, etc). */
export function fixOcrDigits(s: string): string {
	return s
		.replace(/[JjIil|!]/g, '1')
		.replace(/[Oo]/g, '0')
		.replace(/[Ss]/g, '5')
		.replace(/[Bb]/g, '8')
		.replace(/[Zz]/g, '2')
		.replace(/[)]/g, '1')
		.replace(/[^0-9]/g, '');
}

export function stripLeadingZeros(s: string): string {
	const stripped = s.replace(/^0+/, '');
	return stripped || '0';
}

export interface CollectorInfo {
	setCode: string;
	collectorNumber: string;
	foilFromText: boolean;
	/**
	 * How the collector number was found. 'fraction' (123/277) and 'rarity'
	 * (C 0123) are reliable; 'weak' means "the last digits before the set
	 * code", which can be the set total or any other number — callers should
	 * treat a weak number as a hint and sanity-check the result.
	 */
	numberSource: 'fraction' | 'pair' | 'rarity' | 'weak' | 'none';
	/**
	 * Rarity letter printed next to the collector number (c/u/r/m/l/s/t,
	 * lower-case), '' when none was read. Lets callers reject a set+number hit
	 * whose rarity contradicts the printed letter (a misread digit otherwise
	 * silently yields a wrong card).
	 */
	rarity: string;
	/** Two-letter language code read after the set code ("EN", "DE", ...), '' when no anchor matched. */
	language: string;
}

/**
 * Extract set code + collector number + foil hint from the bottom-line OCR.
 * @param text raw OCR output from the bottom strip of a card
 * @param langs pipe-separated list of 2-letter language codes the anchor regex should accept
 * @param dbg optional per-step debug logger
 */
export function parseCollectorInfo(text: string, langs: string, dbg?: (msg: string) => void): CollectorInfo {
	const result: CollectorInfo = { setCode: '', collectorNumber: '', foilFromText: false, numberSource: 'none', rarity: '', language: '' };

	// Step 1: Find anchor — <SET code, 3-4 alphanumeric> followed by <LANG 2-letter> within a few chars
	const anchor = new RegExp(`\\b([A-Z0-9]{3,4})\\s*([^A-Za-z0-9\\s]?)\\s*(${langs})\\b`, 'gi');
	let anchorMatch: RegExpMatchArray | null = null;
	for (const m of text.matchAll(anchor)) {
		// Set codes are not always 3 letters: many are alphanumeric (M21, 2X2,
		// 40K, MH2, 10E). Require at least one letter so a pure-number candidate
		// (e.g. a collector total sitting before a language code) is skipped and
		// we keep scanning for the real lettered set code.
		if (/[A-Z]/i.test(m[1])) {
			anchorMatch = m;
			break;
		}
	}

	if (anchorMatch) {
		result.setCode = anchorMatch[1].toLowerCase();
		result.language = anchorMatch[3].toUpperCase();
		dbg?.(`anchor matched: "${anchorMatch[0]}" -> set="${result.setCode}"`);

		// Check separator character for foil hint
		const sep = anchorMatch[2] || '';
		result.foilFromText = /[*#&]/.test(sep);
		dbg?.(`separator="${sep}" foilFromSep=${result.foilFromText}`);

		// Step 2: Extract collector number from text BEFORE the set code
		const before = text.substring(0, anchorMatch.index);
		dbg?.(`text before anchor: "${before}"`);

		// Handle fraction format first (Era 3): "010/277"
		const fractionMatch = before.match(/([\dOoIilJjBbSsZz]{1,4})\/([\dOoIilJjBbSsZz]{1,4})/);
		// OCR often drops the slash: "040 277 C". Two numbers followed by a
		// rarity letter are collector number + set total; the first one counts,
		// and a "number" larger than the total is an OCR merge ("1820 277 C"
		// for 180/277) that must not be used at all.
		const pairMatch = !fractionMatch ? before.match(/(\d{1,4})\s+(\d{2,4})\s*([CURMLST])?\s*$/) : null;
		if (fractionMatch) {
			result.collectorNumber = stripLeadingZeros(fixOcrDigits(fractionMatch[1]));
			result.numberSource = 'fraction';
			// "180/277 C": the rarity letter follows the fraction.
			const afterFraction = before.slice((fractionMatch.index ?? 0) + fractionMatch[0].length).match(/^\s*([CURMLST])(?![A-Za-z])/i);
			if (afterFraction) result.rarity = afterFraction[1].toLowerCase();
			// Printed numerators are zero-padded to the width of the total
			// ("040/277"); a shorter numerator means the OCR dropped a digit and
			// "4/277" may be 040 or 240 — a hint only, not an identification.
			if (fixOcrDigits(fractionMatch[1]).length < fixOcrDigits(fractionMatch[2]).length) {
				result.numberSource = 'weak';
				dbg?.(`numerator shorter than the total ("${fractionMatch[0]}"): digit dropped, number downgraded to weak`);
			}
			dbg?.(`fraction format: "${fractionMatch[0]}" -> num="${result.collectorNumber}"`);
		} else if (pairMatch) {
			const num = stripLeadingZeros(pairMatch[1]);
			const total = Number(pairMatch[2]);
			if (Number(num) <= total) {
				result.collectorNumber = num;
				result.numberSource = 'pair';
				if (pairMatch[3]) result.rarity = pairMatch[3].toLowerCase();
				dbg?.(`number/total pair: "${pairMatch[0]}" -> num="${result.collectorNumber}"`);
			} else {
				dbg?.(`number/total pair rejected: ${num} > total ${total} ("${pairMatch[0]}")`);
			}
		} else {
			// Strategy: find the collector number near the end of `before`.
			// It may be split by spaces/OCR errors: "C 0 045" or "0045" or "024 J"
			// Take the last ~20 chars before the set code and extract all digit-like content
			const tail = before.slice(-20).trim();
			dbg?.(`tail (last 20 chars): "${tail}"`);

			// Try to find a rarity+number pattern: "C 0045", "R 024 J", "M0085", "L 0187" (basic lands print L)
			const rarityNumMatch = tail.match(/([CURML])\s*([\d\s]{1,8}[JjIil|!)Oo]?)\s*$/i);
			if (rarityNumMatch) {
				const fixed = fixOcrDigits(rarityNumMatch[2].replace(/\s/g, ''));
				if (fixed.length > 0 && fixed.length <= 4) {
					result.collectorNumber = stripLeadingZeros(fixed);
					result.numberSource = 'rarity';
					result.rarity = rarityNumMatch[1].toLowerCase();
					dbg?.(`rarity+number: "${rarityNumMatch[0]}" -> num="${result.collectorNumber}"`);
					// Printed numbers have at least three digits ("C 0156", "R 024");
					// fewer means the OCR dropped one.
					if (fixed.length < 3) {
						result.numberSource = 'weak';
						dbg?.(`only ${fixed.length} digit(s) after the rarity letter: number downgraded to weak`);
					}
				}
			}

			// Fallback: just find the last digit sequence
			if (!result.collectorNumber) {
				const allDigits = [...before.matchAll(/\d{1,4}/g)];
				if (allDigits.length > 0) {
					const lastMatch = allDigits[allDigits.length - 1];
					let raw = lastMatch[0];
					const afterIdx = (lastMatch.index ?? 0) + raw.length;
					const after = before.substring(afterIdx).replace(/^\s+/, '');
					if (after.length > 0 && /^[JjIil|!)Oo](?:\s|$)/.test(after)) {
						raw += after[0];
					}
					const fixed = fixOcrDigits(raw);
					if (fixed.length > 0 && fixed.length <= 4) {
						result.collectorNumber = stripLeadingZeros(fixed);
						result.numberSource = 'weak';
						dbg?.(`last-digit fallback: raw="${raw}" -> num="${result.collectorNumber}"`);
					}
				}
				if (!result.collectorNumber) {
					dbg?.('no collector number found in before-text');
				}
			}
		}
		// Preserve a trailing variant letter (e.g. "291a") when the parsed digits
		// are immediately followed by a single lowercase letter in the before-text.
		if (result.collectorNumber && /^\d+$/.test(result.collectorNumber)) {
			const suf = before.match(new RegExp(`\\b0*${result.collectorNumber}([a-z])\\b`));
			if (suf) {
				result.collectorNumber += suf[1];
				dbg?.(`variant suffix appended -> "${result.collectorNumber}"`);
			}
		}
	} else {
		dbg?.('no anchor match (SET+LANG pattern not found)');
	}

	// Fallback: any uppercase 3-4 char set-like token + any number.
	if (!result.setCode) {
		// Stay case-sensitive (uppercase) here: set codes are uppercase on cards,
		// while an 'i' flag would also match lowercase flavor/artist words. Allow
		// digits but require an uppercase letter, skipping pure-number tokens.
		for (const m of text.matchAll(/\b([A-Z0-9]{3,4})\b/g)) {
			if (/[A-Z]/.test(m[1])) {
				result.setCode = m[1].toLowerCase();
				break;
			}
		}
		const fractionMatch = text.match(/(\d{1,4})\/(\d{1,4})(?:\s*([CURMLST])(?![A-Za-z]))?/i);
		// "C 0150" / "Cc 0150" (OCR doubles letters) / "C0047" (space lost):
		// rarity + number is reliable even when the set code next to it was unreadable.
		const rarityMatch = !fractionMatch ? text.match(/(?:^|\s)([curml]{1,2})\s*(0*\d{1,4})(?!\d)/i) : null;
		if (fractionMatch) {
			result.collectorNumber = stripLeadingZeros(fractionMatch[1]);
			// Same padding rule as above: a numerator shorter than the total lost a digit.
			result.numberSource = fractionMatch[1].length < fractionMatch[2].length ? 'weak' : 'fraction';
			if (fractionMatch[3]) result.rarity = fractionMatch[3].toLowerCase();
		} else if (rarityMatch) {
			result.collectorNumber = stripLeadingZeros(rarityMatch[2]);
			result.numberSource = rarityMatch[2].length < 3 ? 'weak' : 'rarity';
			result.rarity = rarityMatch[1][0].toLowerCase();
		} else {
			const numMatch = text.match(/(\d{1,4})/);
			if (numMatch) {
				result.collectorNumber = stripLeadingZeros(numMatch[1]);
				result.numberSource = 'weak';
			}
		}
		dbg?.(`generic fallback: set="${result.setCode}" num="${result.collectorNumber}"`);
	}

	// Foil fallback: if anchor didn't match, check for * anywhere in text.
	// The star/bullet separator is distinctive enough as a foil indicator.
	if (!result.foilFromText && text.includes('*')) {
		result.foilFromText = true;
		dbg?.('foil detected via * in text');
	}

	return result;
}
