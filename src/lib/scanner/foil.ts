import type { WordBox } from './tesseract.js';

/**
 * Pixel-based foil detection for the bottom collector-info line.
 *
 * MTG cards carry either a bullet `•` (non-foil) or a filled star `★`
 * (foil) between the SET code and the language code. Tesseract reads
 * both as `*` at small sizes, so the text-based hint is unreliable.
 * This sampler instead looks at the actual pixels between the word
 * bounding boxes: the star covers ~15-30 % of the separator region
 * with bright pixels, a bullet only ~5-12 %.
 *
 * Needs:
 * - `canvas`: the bottom strip the Tesseract worker actually saw
 *   (same coordinate space as the word bboxes).
 * - `words`: word-level output from `recognizeDetailed`.
 * - `setCode`: previously parsed 3-letter set code.
 * - `langs`: allowed language codes (e.g. ['EN', 'DE', 'FR', ...]).
 *
 * Returns `null` when the separator region can't be located reliably —
 * callers should treat that as "don't change the foil flag".
 */
export function detectFoilFromSeparator(
	canvas: HTMLCanvasElement,
	words: WordBox[],
	setCode: string,
	langs: string[],
	dbg?: (msg: string) => void
): { foil: boolean; brightRatio: number } | null {
	if (!setCode || !words.length) {
		dbg?.(`foil-pixel: no setCode/words`);
		return null;
	}
	const setUpper = setCode.toUpperCase();
	const langsUpper = langs.map((l) => l.toUpperCase());

	let setWord: WordBox | null = null;
	let langWord: WordBox | null = null;
	for (const w of words) {
		const t = (w.text || '').toUpperCase().replace(/[^A-Z]/g, '');
		if (!setWord && t === setUpper) {
			setWord = w;
			continue;
		}
		if (setWord && langsUpper.includes(t)) {
			langWord = w;
			break;
		}
	}
	if (!setWord || !langWord) {
		dbg?.(`foil-pixel: could not locate SET='${setUpper}' or LANG in words [${words.map((w) => w.text).join('|')}]`);
		return null;
	}

	const sepX1 = setWord.bbox.x1;
	const sepX2 = langWord.bbox.x0;
	const sepY0 = Math.min(setWord.bbox.y0, langWord.bbox.y0);
	const sepY1 = Math.max(setWord.bbox.y1, langWord.bbox.y1);
	const sepW = sepX2 - sepX1;
	const sepH = sepY1 - sepY0;

	if (sepW < 4 || sepH < 4) {
		dbg?.(`foil-pixel: separator too small ${sepW}x${sepH}`);
		return null;
	}

	const ctx = canvas.getContext('2d');
	if (!ctx) return null;

	let imageData: ImageData;
	try {
		imageData = ctx.getImageData(sepX1, sepY0, sepW, sepH);
	} catch (err) {
		dbg?.(`foil-pixel: getImageData failed: ${err}`);
		return null;
	}
	const pixels = imageData.data;
	let brightPixels = 0;
	const totalPixels = sepW * sepH;
	for (let i = 0; i < pixels.length; i += 4) {
		const brightness = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
		if (brightness > 140) brightPixels++;
	}
	const brightRatio = brightPixels / totalPixels;
	dbg?.(`foil-pixel: region=${sepW}x${sepH} bright=${(brightRatio * 100).toFixed(1)}%`);

	return {
		// 0.13 sits between the empirical ranges of bullet (~5-12%) and
		// star (~15-30%) fill ratios.
		foil: brightRatio > 0.13,
		brightRatio
	};
}
