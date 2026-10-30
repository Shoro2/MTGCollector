/**
 * The Content-Security-Policy every response carries (src/hooks.server.ts).
 * Kept in its own module, free of db.ts, so a unit test can check it against
 * the hosts the scanner libraries come from.
 *
 * Permissive on purpose: the app loads OpenCV and Tesseract from CDNs and
 * embeds a self-hosted Plausible script. 'unsafe-inline' is required by
 * SvelteKit's hydration payloads; 'unsafe-eval' is required by OpenCV's WASM
 * glue. A new external host (script, image, fetch) must be added here, or the
 * scanner, images or analytics break silently. challenges.cloudflare.com serves
 * the Turnstile captcha (its script and its iframe) on /contact and when a deck
 * is made public.
 */
export const CSP_DIRECTIVES = [
	"default-src 'self'",
	"script-src 'self' 'unsafe-inline' 'unsafe-eval' https://docs.opencv.org https://cdn.jsdelivr.net https://analytics.mtg-collector.com https://challenges.cloudflare.com",
	"style-src 'self' 'unsafe-inline'",
	// Card images come from this host (/card-image, src/lib/server/card-image-cache.ts), never
	// from Scryfall's CDN; data: is the placeholder of an image that failed (src/lib/card-image.ts).
	"img-src 'self' data: blob: https://lh3.googleusercontent.com",
	// data: is for OpenCV.js, whose single-file build fetches its embedded WASM
	// from a data: URL (it silently falls back to a slower path when refused).
	// docs.opencv.org: turning on the scanner's offline mode fetches OpenCV.js
	// once with fetch(url, { mode: 'no-cors' }) so the service worker stores it
	// (src/lib/offline/client.ts). A fetch is governed by connect-src, not by
	// script-src; without the host Firefox refused it with "NetworkError when
	// attempting to fetch resource." (owner's phone, 2026-10-29).
	"connect-src 'self' data: https://api.scryfall.com https://api.frankfurter.dev https://analytics.mtg-collector.com https://cdn.jsdelivr.net https://docs.opencv.org",
	"font-src 'self' data:",
	"frame-src https://challenges.cloudflare.com",
	"worker-src 'self' blob:",
	"frame-ancestors 'none'",
	"base-uri 'self'",
	"form-action 'self' https://accounts.google.com"
];

export const CSP = CSP_DIRECTIVES.join('; ');

/** The sources of one directive (`connect-src` → ["'self'", "data:", …]); empty when it is absent. */
export function cspSources(directive: string): string[] {
	const entry = CSP_DIRECTIVES.find((d) => d.split(/\s+/)[0] === directive);
	return entry ? entry.split(/\s+/).slice(1) : [];
}
