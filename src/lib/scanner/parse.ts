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
}

/**
 * Extract set code + collector number + foil hint from the bottom-line OCR.
 * @param text raw OCR output from the bottom strip of a card
 * @param langs pipe-separated list of 2-letter language codes the anchor regex should accept
 * @param dbg optional per-step debug logger
 */
export function parseCollectorInfo(text: string, langs: string, dbg?: (msg: string) => void): CollectorInfo {
	const result: CollectorInfo = { setCode: '', collectorNumber: '', foilFromText: false };

	// Step 1: Find anchor — <SET 3-letter> followed by <LANG 2-letter> within a few chars
	const anchor = new RegExp(`\\b([A-Z]{3})\\s*([^A-Za-z0-9\\s]?)\\s*(?:${langs})\\b`, 'i');
	const anchorMatch = text.match(anchor);

	if (anchorMatch) {
		result.setCode = anchorMatch[1].toLowerCase();
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
		if (fractionMatch) {
			result.collectorNumber = stripLeadingZeros(fixOcrDigits(fractionMatch[1]));
			dbg?.(`fraction format: "${fractionMatch[0]}" -> num="${result.collectorNumber}"`);
		} else {
			// Strategy: find the collector number near the end of `before`.
			// It may be split by spaces/OCR errors: "C 0 045" or "0045" or "024 J"
			// Take the last ~20 chars before the set code and extract all digit-like content
			const tail = before.slice(-20).trim();
			dbg?.(`tail (last 20 chars): "${tail}"`);

			// Try to find a rarity+number pattern: "C 0045", "R 024 J", "M0085"
			const rarityNumMatch = tail.match(/[CURM]\s*([\d\s]{1,8}[JjIil|!)Oo]?)\s*$/i);
			if (rarityNumMatch) {
				const fixed = fixOcrDigits(rarityNumMatch[1].replace(/\s/g, ''));
				if (fixed.length > 0 && fixed.length <= 4) {
					result.collectorNumber = stripLeadingZeros(fixed);
					dbg?.(`rarity+number: "${rarityNumMatch[0]}" -> num="${result.collectorNumber}"`);
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
						dbg?.(`last-digit fallback: raw="${raw}" -> num="${result.collectorNumber}"`);
					}
				}
				if (!result.collectorNumber) {
					dbg?.('no collector number found in before-text');
				}
			}
		}
	} else {
		dbg?.('no anchor match (SET+LANG pattern not found)');
	}

	// Fallback: any 3-letter uppercase + any number
	if (!result.setCode) {
		const setMatch = text.match(/\b([A-Z]{3})\b/);
		if (setMatch) result.setCode = setMatch[1].toLowerCase();
		const fractionMatch = text.match(/(\d{1,4})\/\d{1,4}/);
		if (fractionMatch) {
			result.collectorNumber = stripLeadingZeros(fractionMatch[1]);
		} else {
			const numMatch = text.match(/(\d{1,4})/);
			if (numMatch) result.collectorNumber = stripLeadingZeros(numMatch[1]);
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
