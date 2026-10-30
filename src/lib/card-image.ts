/**
 * Card images that fail to load.
 *
 * Card images are hot-linked from Scryfall's CDN (`cards.scryfall.io`). When one
 * fails (a stale URL, a block at Scryfall's edge, no connection) the browser
 * shows its broken-image glyph with the alt text squeezed into the thumbnail
 * (owner report 2026-10-30). `cardImageError()` is the `onerror` handler of every
 * card `<img>`: it swaps the image for a card-shaped placeholder that names the
 * card. Svelte replays an `error` that fired before hydration for an `<img>` with
 * an `onerror` attribute, so server-rendered images are covered as well.
 */

const PLACEHOLDER_WIDTH = 488;
const PLACEHOLDER_HEIGHT = 680;
const LINE_CHARS = 16;
const MAX_LINES = 5;

/** Marks an image that already shows the placeholder, so it is never replaced twice. */
export const FALLBACK_ATTRIBUTE = 'data-image-fallback';

function escapeXml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Splits a card name into at most `MAX_LINES` lines of about `LINE_CHARS` characters; long words are cut. */
export function wrapName(name: string): string[] {
	const words = name.trim().split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let line = '';
	for (const raw of words) {
		const word = raw.length > LINE_CHARS ? `${raw.slice(0, LINE_CHARS - 1)}…` : raw;
		if (!line) line = word;
		else if (line.length + 1 + word.length <= LINE_CHARS) line += ` ${word}`;
		else {
			lines.push(line);
			line = word;
		}
	}
	if (line) lines.push(line);
	if (lines.length > MAX_LINES) {
		const kept = lines.slice(0, MAX_LINES);
		const last = kept[MAX_LINES - 1];
		kept[MAX_LINES - 1] = last.length >= LINE_CHARS ? `${last.slice(0, LINE_CHARS - 1)}…` : `${last}…`;
		return kept;
	}
	return lines;
}

/**
 * A card-shaped SVG (488 × 680, the size of Scryfall's "normal" image) as a
 * data URL: the app's dark surface, a frame and the card's name. `data:` is in
 * the CSP's img-src. Colours are the tokens of src/app.css, written out because
 * an image cannot read CSS variables.
 */
export function cardPlaceholder(name: string): string {
	const lines = wrapName(name || 'Card image');
	const lineHeight = 46;
	const firstY = PLACEHOLDER_HEIGHT / 2 - ((lines.length - 1) * lineHeight) / 2;
	const text = lines
		.map((line, i) => `<tspan x="244" y="${firstY + i * lineHeight}">${escapeXml(line)}</tspan>`)
		.join('');
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PLACEHOLDER_WIDTH} ${PLACEHOLDER_HEIGHT}">` +
		`<rect width="488" height="680" rx="26" fill="#101722"/>` +
		`<rect x="18" y="18" width="452" height="644" rx="16" fill="none" stroke="#243246" stroke-width="4"/>` +
		`<text fill="#8a97a8" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="38" font-weight="600" text-anchor="middle" dominant-baseline="middle">${text}</text>` +
		`<text x="244" y="610" fill="#5d6878" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="24" text-anchor="middle">Image unavailable</text>` +
		`</svg>`;
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * The name to print on the placeholder: the alt text without the
 * "Magic: The Gathering - " prefix and the set in parentheses that card and
 * printing pages add for search engines.
 */
export function placeholderName(alt: string): string {
	return alt
		.replace(/^Magic: The Gathering - /, '')
		.replace(/\s*\([^)]*\)\s*$/, '')
		.trim();
}

/** `onerror` handler for card images: shows the placeholder once (srcset removed, or the browser would retry it). */
export function cardImageError(event: Event): void {
	const img = event.currentTarget instanceof HTMLImageElement ? event.currentTarget : event.target;
	if (!(img instanceof HTMLImageElement) || img.hasAttribute(FALLBACK_ATTRIBUTE)) return;
	img.setAttribute(FALLBACK_ATTRIBUTE, img.currentSrc || img.src);
	img.removeAttribute('srcset');
	img.removeAttribute('sizes');
	img.src = cardPlaceholder(placeholderName(img.alt));
}

/**
 * Card images served by this site (owner decision 2026-10-30, "Fix und Cache in
 * diesem PR"): the browser asks `/card-image/<size>/<side>/<printing id>.jpg`
 * instead of Scryfall's CDN; the server fetches the image from Scryfall once,
 * keeps it under `data/card-images/` and serves it from there
 * (src/lib/server/card-image-cache.ts). `?v=` carries Scryfall's image version,
 * so a re-scanned image gets a new URL and the old one can be cached forever.
 */
export const CARD_IMAGE_SIZES = ['small', 'normal', 'large'] as const;
export type CardImageSize = (typeof CARD_IMAGE_SIZES)[number];
export type CardImageSide = 'front' | 'back';

/** Scryfall's image URL: `https://cards.scryfall.io/<size>/<side>/<a>/<b>/<id>.jpg?<version>`. */
const SCRYFALL_IMAGE = /^https:\/\/cards\.scryfall\.io\/(small|normal|large)\/(front|back)\/([0-9a-f])\/([0-9a-f])\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jpg(?:\?(\d+))?$/;

export interface ScryfallImage {
	size: CardImageSize;
	side: CardImageSide;
	id: string;
	version: string | null;
}

/** The parts of a Scryfall card image URL; null for anything else (local paths, blobs, other hosts). */
export function parseScryfallImage(uri: string | null | undefined): ScryfallImage | null {
	const m = uri ? SCRYFALL_IMAGE.exec(uri) : null;
	if (!m || m[3] !== m[5][0] || m[4] !== m[5][1]) return null;
	return { size: m[1] as CardImageSize, side: m[2] as CardImageSide, id: m[5], version: m[6] ?? null };
}

/** The Scryfall URL of the same image at another size (the CDN uses one layout for every size). */
export function scryfallImageAtSize(image: ScryfallImage, size: CardImageSize): string {
	const { side, id, version } = image;
	return `https://cards.scryfall.io/${size}/${side}/${id[0]}/${id[1]}/${id}.jpg${version ? `?${version}` : ''}`;
}

/** This site's URL for a card image; `uri` passes through unchanged when it is not a Scryfall card image. */
export function cardImageSrc(uri: string | null | undefined, size?: CardImageSize): string {
	if (!uri) return '';
	const image = parseScryfallImage(uri);
	if (!image) return uri;
	const version = image.version ? `?v=${image.version}` : '';
	return `/card-image/${size ?? image.size}/${image.side}/${image.id}.jpg${version}`;
}

/** The three sizes Scryfall serves (146, 488 and 672 px wide) as a srcset; null when `uri` is not a Scryfall image. */
export function cardImageSrcset(uri: string | null | undefined): string | null {
	if (!parseScryfallImage(uri)) return null;
	return `${cardImageSrc(uri, 'small')} 146w, ${cardImageSrc(uri, 'normal')} 488w, ${cardImageSrc(uri, 'large')} 672w`;
}
