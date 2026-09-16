/**
 * Image side of the art-hash index (scanner Phase 3): fetch a printing's
 * Scryfall image and hash its art box with the pipeline the scanner shares
 * (`hashArtPixels`). No database here, so the unit tests can import it
 * without opening `data/mtg.db` (two vitest workers creating that file at the
 * same moment locked each other out on CI).
 */
import sharp from 'sharp';
import { ART_BOX, hashArtPixels } from '../scanner/phash.js';

const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = 'MTGCollector/1.0 (art-hash index; github.com/Shoro2/MTGCollector)';

/** Scryfall serves every image size under the same path; `small` (146x204) is plenty for a 32x32 hash and a fifth of the bytes. */
export function smallImageUrl(imageUri: string): string {
	return imageUri.replace('/normal/', '/small/');
}

/** Hash of the art box of an encoded card image (JPEG/PNG bytes). */
export async function hashImageBytes(bytes: Buffer): Promise<string> {
	const meta = await sharp(bytes).metadata();
	const w = meta.width ?? 0;
	const h = meta.height ?? 0;
	if (w < 16 || h < 16) throw new Error(`image too small (${w}x${h})`);
	const box = {
		left: Math.round(w * ART_BOX.x),
		top: Math.round(h * ART_BOX.y),
		width: Math.max(1, Math.round(w * ART_BOX.w)),
		height: Math.max(1, Math.round(h * ART_BOX.h))
	};
	// Decode the box at its native size and hand the pixels to the shared
	// pipeline (luminance, box-filter resize, DCT) — the scanner does the same
	// with its warped card, so no resampler difference creeps into the bits.
	const { data, info } = await sharp(bytes).extract(box).removeAlpha().raw().toBuffer({ resolveWithObject: true });
	return hashArtPixels(data, info.width, info.height, info.channels);
}

/** Fetch an image; null for a 404 (a card without that size), an error for anything else. */
export async function fetchImage(url: string): Promise<Buffer | null> {
	const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
}

/** Small image first, the stored size when Scryfall has no small rendition. */
export async function hashImageUrl(imageUri: string): Promise<string | null> {
	const small = smallImageUrl(imageUri);
	let bytes = await fetchImage(small);
	if (!bytes && small !== imageUri) bytes = await fetchImage(imageUri);
	if (!bytes) return null;
	return hashImageBytes(bytes);
}
