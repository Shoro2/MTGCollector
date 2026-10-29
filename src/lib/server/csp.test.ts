import { describe, expect, it } from 'vitest';
import { CSP, cspSources } from './csp';
import { LIBRARY_HOSTS } from '../offline/routes';

const DEFAULT_LIBRARY_URLS = [
	'https://docs.opencv.org/4.9.0/opencv.js',
	'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js',
	'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.wasm.min.mjs'
];

describe('content security policy', () => {
	it('lets the page load every default scanner library as a script', () => {
		const scripts = cspSources('script-src');
		for (const url of DEFAULT_LIBRARY_URLS) expect(scripts).toContain(new URL(url).origin);
	});

	it('lets the page fetch every library host the offline mode stores', () => {
		// enableOffline() fetches OpenCV.js with mode: 'no-cors'; connect-src decides, not script-src.
		const connect = cspSources('connect-src');
		for (const host of LIBRARY_HOSTS) expect(connect).toContain(`https://${host}`);
	});

	it('keeps the data: source OpenCV.js needs for its embedded WASM', () => {
		expect(cspSources('connect-src')).toContain('data:');
	});

	it('lets the Turnstile captcha load its script and its iframe', () => {
		expect(cspSources('script-src')).toContain('https://challenges.cloudflare.com');
		expect(cspSources('frame-src')).toEqual(['https://challenges.cloudflare.com']);
	});

	it('joins the directives into one header value', () => {
		expect(CSP.split('; ')[0]).toBe("default-src 'self'");
		expect(CSP).not.toMatch(/;;|\n/);
		expect(cspSources('no-such-directive')).toEqual([]);
	});
});
