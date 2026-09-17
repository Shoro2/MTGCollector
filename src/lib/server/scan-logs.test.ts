import { describe, expect, it } from 'vitest';
import { dirsToPrune, isSafeLogName, parseScanLogHeader, scanLogFileName, summariseLogText, truncateLogText, SCAN_LOG_MAX_BYTES } from './scan-logs';

describe('scan log file names', () => {
	it('puts a log under its UTC day with a sortable time prefix', () => {
		expect(scanLogFileName(new Date('2026-09-16T19:03:07.123Z'), 'ab12cd34')).toBe('2026-09-16/190307-ab12cd34.log');
	});

	it('accepts only names it produced itself', () => {
		expect(isSafeLogName('2026-09-16/190307-ab12cd34.log')).toBe(true);
		expect(isSafeLogName('../../etc/passwd')).toBe(false);
		expect(isSafeLogName('2026-09-16/../x.log')).toBe(false);
		expect(isSafeLogName('2026-09-16/190307-ab12cd34.txt')).toBe(false);
		expect(isSafeLogName('')).toBe(false);
	});
});

describe('retention', () => {
	it('selects day directories older than the retention window and ignores foreign names', () => {
		const now = new Date('2026-09-16T12:00:00Z');
		expect(dirsToPrune(['2026-08-01', '2026-08-17', '2026-08-18', '2026-09-16', 'notes', '.DS_Store'], now, 30)).toEqual(['2026-08-01', '2026-08-17']);
	});
});

describe('log text', () => {
	it('keeps the end of an over-long log, where the decisions are', () => {
		const text = 'a'.repeat(SCAN_LOG_MAX_BYTES + 100);
		const cut = truncateLogText(text);
		expect(cut.length).toBeLessThanOrEqual(SCAN_LOG_MAX_BYTES);
		expect(cut.startsWith('[truncated')).toBe(true);
	});

	it('extracts the detector, the completion line and the live capture count', () => {
		const text = [
			'[+0.10s] [live] detector: Web Worker (OpenCV.js off the main thread)',
			'[+2.30s] [live] Best frame of the scene: sharpness 412, glare 0.4%, 120 ms old',
			'[+5.00s] Scan complete: 1/1 identified'
		].join('\n');
		expect(summariseLogText(text)).toEqual({ detector: 'Web Worker (OpenCV.js off the main thread)', complete: '1/1 identified', bestFrames: 1 });
		expect(summariseLogText('nothing here')).toEqual({ detector: '', complete: '', bestFrames: 0 });
		// a live session appends scan after scan to one log: the header reports the last one
		expect(summariseLogText(['Scan complete: 1/1 identified', '[live] Live capture', 'Scan complete: 0/3 identified'].join('\n')).complete).toBe('0/3 identified');
	});

	it('reads the JSON header line back and tolerates a damaged one', () => {
		const good = '{"mode":"live","source":"live","cards":1}\n[+0.10s] hello';
		expect(parseScanLogHeader(good)).toMatchObject({ meta: { mode: 'live', source: 'live', cards: 1 }, text: '[+0.10s] hello' });
		expect(parseScanLogHeader('not json\nline')).toEqual({ meta: {}, text: 'not json\nline' });
	});
});
