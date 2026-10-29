import { describe, expect, it } from 'vitest';
import { cacheable, libraryCache, LIBS_CACHE, LIBS_OPAQUE_CACHE, offlineRoute, precacheList, scannerPageKey } from './routes';
import { MAX_ATTEMPTS, pendingScans, queuedScanFromRecord, storableRects, type QueuedScan } from './queue';
import { formatBytes } from './client';
import { defaultSession } from '../scanner/session';

const ORIGIN = 'https://mtg-collector.com';
const route = (url: string, mode = 'cors', method = 'GET') => offlineRoute({ url, method, mode }, ORIGIN);

describe('offlineRoute', () => {
	it('handles the scanner page, its data and nothing else of the app', () => {
		expect(route(`${ORIGIN}/scan`, 'navigate')).toBe('scanner-page');
		expect(route(`${ORIGIN}/scan?mode=live`, 'navigate')).toBe('scanner-page');
		expect(route(`${ORIGIN}/scan/__data.json?x-sveltekit-invalidated=01`)).toBe('scanner-page');
		expect(route(`${ORIGIN}/collection`, 'navigate')).toBe('navigation');
		expect(route(`${ORIGIN}/collection/__data.json`)).toBe('pass');
		expect(route(`${ORIGIN}/api/prices/data`)).toBe('pass');
	});

	it('never touches writes, so a scan lookup or an add fails visibly when offline', () => {
		expect(route(`${ORIGIN}/scan`, 'cors', 'POST')).toBe('pass');
		expect(route(`${ORIGIN}/collection`, 'cors', 'POST')).toBe('pass');
		expect(route(`${ORIGIN}/api/scan-log`, 'cors', 'POST')).toBe('pass');
	});

	it('caches immutable chunks and the offline scanner assets', () => {
		expect(route(`${ORIGIN}/_app/immutable/chunks/abc.js`)).toBe('immutable');
		expect(route(`${ORIGIN}/scanner/detect-worker.js?v=123`)).toBe('asset');
		expect(route(`${ORIGIN}/offline.html`, 'navigate')).toBe('asset');
		expect(route(`${ORIGIN}/icons/icon-192.png`)).toBe('asset');
		expect(route(`${ORIGIN}/manifest.webmanifest`)).toBe('asset');
		expect(route(`${ORIGIN}/_app/version.json`)).toBe('pass');
	});

	it('keeps only OpenCV of the scanner libraries, self-hosted or from its CDN', () => {
		expect(route(`${ORIGIN}/vendor/opencv.js`, 'no-cors')).toBe('library');
		expect(route(`${ORIGIN}/vendor/tesseract/worker.min.js`)).toBe('pass');
		expect(route(`${ORIGIN}/vendor/paddle/ch_PP-OCRv4_rec_infer.onnx`)).toBe('pass');
		expect(route('https://docs.opencv.org/4.9.0/opencv.js', 'no-cors')).toBe('library');
		expect(route('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js')).toBe('pass');
		expect(route('https://cards.scryfall.io/normal/front/a/b/x.jpg', 'no-cors')).toBe('pass');
		expect(route('https://analytics.mtg-collector.com/js/script.js', 'no-cors')).toBe('pass');
	});

	it('drops the cached scanner page on sign-out and account deletion', () => {
		expect(route(`${ORIGIN}/auth/logout`, 'navigate', 'POST')).toBe('logout');
		expect(route(`${ORIGIN}/auth/logout`, 'navigate')).toBe('logout');
		expect(route(`${ORIGIN}/api/account`, 'cors', 'DELETE')).toBe('logout');
		expect(route(`${ORIGIN}/auth/logout`)).toBe('pass');
		expect(route(`${ORIGIN}/api/account`)).toBe('pass');
	});

	it('passes malformed URLs', () => {
		expect(offlineRoute({ url: 'not a url', method: 'GET', mode: 'cors' }, ORIGIN)).toBe('pass');
	});
});

describe('scannerPageKey', () => {
	it('ignores the query and a trailing slash', () => {
		expect(scannerPageKey(`${ORIGIN}/scan?mode=live`)).toBe(`${ORIGIN}/scan`);
		expect(scannerPageKey(`${ORIGIN}/scan/`)).toBe(`${ORIGIN}/scan`);
		expect(scannerPageKey(`${ORIGIN}/scan/__data.json?x-sveltekit-invalidated=01`)).toBe(`${ORIGIN}/scan/__data.json`);
	});
});

describe('libraryCache', () => {
	it('keeps opaque cross-origin scripts apart, and same-origin copies in one cache whatever the mode', () => {
		expect(libraryCache('https://docs.opencv.org/4.9.0/opencv.js', ORIGIN, 'no-cors')).toBe(LIBS_OPAQUE_CACHE);
		expect(libraryCache('https://docs.opencv.org/4.9.0/opencv.js', ORIGIN, 'cors')).toBe(LIBS_CACHE);
		expect(libraryCache(`${ORIGIN}/vendor/opencv.js`, ORIGIN, 'no-cors')).toBe(LIBS_CACHE);
		expect(libraryCache(`${ORIGIN}/vendor/opencv.js`, ORIGIN, 'cors')).toBe(LIBS_CACHE);
	});
});

describe('cacheable', () => {
	it('stores complete successes and opaque scripts only', () => {
		expect(cacheable({ ok: true, status: 200, type: 'basic' })).toBe(true);
		expect(cacheable({ ok: false, status: 0, type: 'opaque' })).toBe(true);
		expect(cacheable({ ok: false, status: 503, type: 'basic' })).toBe(false);
		expect(cacheable({ ok: true, status: 206, type: 'basic' })).toBe(false);
		expect(cacheable({ ok: true, status: 200, type: 'basic', redirected: true })).toBe(false);
	});
});

describe('precacheList', () => {
	it('takes the build, the fallback page, icons and this build\'s worker, never the vendored libraries', () => {
		const list = precacheList(
			['/_app/immutable/a.js', '/_app/immutable/b.css'],
			['/favicon.ico', '/robots.txt', '/offline.html', '/manifest.webmanifest', '/icons/icon-192.png', '/scanner/detect-worker.js', '/vendor/opencv.js', '/card-images/x.jpg'],
			'1730000000000'
		);
		expect(list).toEqual(['/_app/immutable/a.js', '/_app/immutable/b.css', '/favicon.ico', '/offline.html', '/manifest.webmanifest', '/icons/icon-192.png', '/scanner/detect-worker.js?v=1730000000000']);
	});

	it('leaves the worker out when the build has none', () => {
		expect(precacheList([], ['/offline.html'], '1')).toEqual(['/offline.html']);
	});
});

describe('offline queue records', () => {
	const rect = { corners: [[0, 0], [10, 0], [10, 14], [0, 14]] as Array<[number, number]>, rect: { x: 0, y: 0, width: 10, height: 14 }, area: 140 };
	const record = (extra: Record<string, unknown> = {}) => ({ id: 1, createdAt: '2026-10-29T15:00:00.000Z', mode: 'live', image: new Blob(['x'], { type: 'image/jpeg' }), rects: [rect], session: defaultSession(), attempts: 0, ...extra });

	it('accepts a stored capture', () => {
		const scan = queuedScanFromRecord(record());
		expect(scan?.mode).toBe('live');
		expect(scan?.rects).toHaveLength(1);
		expect(queuedScanFromRecord(record({ mode: 'rows' }))?.mode).toBe('rows');
	});

	it('rejects damaged records instead of feeding them to the pipeline', () => {
		expect(queuedScanFromRecord(null)).toBeNull();
		expect(queuedScanFromRecord(record({ mode: 'panorama' }))).toBeNull();
		expect(queuedScanFromRecord(record({ image: 'not a blob' }))).toBeNull();
		expect(queuedScanFromRecord(record({ rects: [{ corners: [[0, 0]] }] }))).toBeNull();
		expect(queuedScanFromRecord(record({ id: undefined }))).toBeNull();
	});

	it('repairs a missing attempt count', () => {
		expect(queuedScanFromRecord(record({ attempts: undefined }))?.attempts).toBe(0);
	});

	it('stores rectangles without the live fingerprints', () => {
		const stored = storableRects([{ ...rect, source: 'fine', spread: 80, fingerprint: { values: [1, 2] } as never }]);
		expect(stored).toEqual([rect]);
		expect(stored[0].corners).not.toBe(rect.corners);
	});

	it('skips captures that failed too often and keeps capture order', () => {
		const scans = [3, 1, 2].map((id) => queuedScanFromRecord(record({ id, attempts: id === 2 ? MAX_ATTEMPTS : 0 }))!) as QueuedScan[];
		expect(pendingScans(scans).map((s) => s.id)).toEqual([1, 3]);
	});
});

describe('formatBytes', () => {
	it('reads like a storage size', () => {
		expect(formatBytes(512)).toBe('1 KB');
		expect(formatBytes(300 * 1024)).toBe('300 KB');
		expect(formatBytes(15.5 * 1024 * 1024)).toBe('15.5 MB');
	});
});
