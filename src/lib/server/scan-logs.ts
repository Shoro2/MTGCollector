/**
 * Server-side scan logs. Every scan on /scan uploads its debug log (text only,
 * never a photo) so a problem seen on a phone can be analysed without copying
 * the log by hand. Logs are plain files under data/scan-logs/<day>/ — readable
 * over SSH without opening the database, listed and shown on /admin, and
 * pruned after SCAN_LOG_RETENTION_DAYS. Each file starts with one JSON header
 * line (the metadata) followed by the log text.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const SCAN_LOG_MAX_BYTES = 512 * 1024;
export const SCAN_LOG_RETENTION_DAYS = 30;
export const SCAN_LOG_DIR = join(process.cwd(), 'data', 'scan-logs');

export type ScanLogInput = {
	mode: string;
	source: string;
	summary: string;
	cards: number;
	identified: number;
	likely: number;
	wallMs: number;
	userAgent: string;
	userId: string | null;
	/** SvelteKit app version of the page that produced the log (changes with every build). */
	version?: string;
	text: string;
};

export type ScanLogMeta = Omit<ScanLogInput, 'text'> & {
	/** ISO time the log was stored. */
	at: string;
	/** Which live detector ran ("Web Worker …" / "main thread (…)"), from the [live] lines. */
	detector: string;
	/** Build stamp of the detection worker bundle that ran (empty for uploads and for bundles from before the stamp). */
	workerBuild: string;
	/** The "Scan complete: …" tail, when the scan finished. */
	complete: string;
	/** Number of best-frame captures in a live session. */
	bestFrames: number;
	bytes: number;
};

/** `<UTC day>/<HHMMSS>-<id>.log` — sorts chronologically within a day. */
export function scanLogFileName(now: Date, id: string): string {
	const iso = now.toISOString();
	return `${iso.slice(0, 10)}/${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}-${id}.log`;
}

/** Only names this module produced are ever opened — no path traversal via the API. */
export function isSafeLogName(name: string): boolean {
	return /^\d{4}-\d{2}-\d{2}\/\d{6}-[a-f0-9]{8}\.log$/.test(name);
}

/** Day directories older than the retention window; anything that is not a day name is left alone. */
export function dirsToPrune(names: string[], now: Date, days: number): string[] {
	// Keep exactly `days` day directories including today: the one `days` days back goes.
	const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
	return names.filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n) && n <= cutoff);
}

/** Keep the end of an over-long log: the decisions are at the end, the detection strategies at the start. */
export function truncateLogText(text: string): string {
	if (Buffer.byteLength(text, 'utf8') <= SCAN_LOG_MAX_BYTES) return text;
	const note = '[truncated: the beginning of the log was dropped]\n';
	const buf = Buffer.from(text, 'utf8');
	let tail = buf.subarray(buf.length - (SCAN_LOG_MAX_BYTES - Buffer.byteLength(note, 'utf8'))).toString('utf8');
	tail = tail.slice(tail.indexOf('\n') + 1);
	return note + tail;
}

/** The lines worth showing in a list without opening the log. */
export function summariseLogText(text: string): { detector: string; workerBuild: string; complete: string; bestFrames: number } {
	const detector = /detector: ([^\n]+)/.exec(text)?.[1].trim() ?? '';
	const workerBuild = /worker build ([^\n]+)/.exec(text)?.[1].trim() ?? '';
	// A live session appends one scan after another to the same log: the last one is the current one.
	const completes = [...text.matchAll(/Scan complete: ([^\n]+)/g)];
	const complete = completes.length ? completes[completes.length - 1][1].trim() : '';
	const bestFrames = (text.match(/Best frame of the scene/g) ?? []).length;
	return { detector, workerBuild, complete, bestFrames };
}

/** Split a stored file into its JSON header and the log text; a damaged header yields empty metadata. */
export function parseScanLogHeader(content: string): { meta: Partial<ScanLogMeta>; text: string } {
	const nl = content.indexOf('\n');
	const first = nl === -1 ? content : content.slice(0, nl);
	try {
		const meta = JSON.parse(first);
		if (meta && typeof meta === 'object' && !Array.isArray(meta)) return { meta, text: nl === -1 ? '' : content.slice(nl + 1) };
	} catch {
		// not a header line
	}
	return { meta: {}, text: content };
}

const clip = (s: unknown, max: number) => (typeof s === 'string' ? s.slice(0, max) : '');
const count = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);

/** Store one log; returns its name. Prunes days older than the retention window on the way. */
export function writeScanLog(input: ScanLogInput, now = new Date()): { name: string } {
	const text = truncateLogText(input.text);
	const meta: ScanLogMeta = {
		at: now.toISOString(),
		mode: clip(input.mode, 20),
		source: clip(input.source, 20),
		summary: clip(input.summary, 200),
		cards: count(input.cards),
		identified: count(input.identified),
		likely: count(input.likely),
		wallMs: count(input.wallMs),
		userAgent: clip(input.userAgent, 300),
		userId: typeof input.userId === 'string' ? input.userId.slice(0, 64) : null,
		version: clip(input.version ?? '', 40),
		...summariseLogText(text),
		bytes: Buffer.byteLength(text, 'utf8')
	};
	const name = scanLogFileName(now, randomBytes(4).toString('hex'));
	const path = join(SCAN_LOG_DIR, name);
	mkdirSync(join(SCAN_LOG_DIR, name.slice(0, 10)), { recursive: true });
	writeFileSync(path, JSON.stringify(meta) + '\n' + text, 'utf8');
	pruneScanLogs(now);
	return { name };
}

export function pruneScanLogs(now = new Date()): void {
	if (!existsSync(SCAN_LOG_DIR)) return;
	for (const dir of dirsToPrune(readdirSync(SCAN_LOG_DIR), now, SCAN_LOG_RETENTION_DAYS)) {
		rmSync(join(SCAN_LOG_DIR, dir), { recursive: true, force: true });
	}
}

/** Read just the header line of a stored log (files are up to 512 KB; the header is a few hundred bytes). */
function readHeader(path: string): Partial<ScanLogMeta> {
	const fd = openSync(path, 'r');
	try {
		const buf = Buffer.alloc(4096);
		const n = readSync(fd, buf, 0, buf.length, 0);
		return parseScanLogHeader(buf.subarray(0, n).toString('utf8')).meta;
	} finally {
		closeSync(fd);
	}
}

export type ScanLogListEntry = { name: string } & Partial<ScanLogMeta>;

/** Newest logs first, at most `limit`, header metadata only. */
export function listScanLogs(limit = 50): ScanLogListEntry[] {
	if (!existsSync(SCAN_LOG_DIR)) return [];
	const out: ScanLogListEntry[] = [];
	const days = readdirSync(SCAN_LOG_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
	for (const day of days) {
		const files = readdirSync(join(SCAN_LOG_DIR, day)).filter((f) => f.endsWith('.log')).sort().reverse();
		for (const f of files) {
			const name = `${day}/${f}`;
			if (!isSafeLogName(name)) continue;
			const path = join(SCAN_LOG_DIR, name);
			try {
				out.push({ name, ...readHeader(path), bytes: statSync(path).size });
			} catch {
				// a file vanished between readdir and open: skip it
			}
			if (out.length >= limit) return out;
		}
	}
	return out;
}

/** One stored log with its metadata, or null when the name is unknown or unsafe. */
export function readScanLog(name: string): { name: string; meta: Partial<ScanLogMeta>; text: string } | null {
	if (!isSafeLogName(name)) return null;
	const path = join(SCAN_LOG_DIR, name);
	if (!existsSync(path)) return null;
	return { name, ...parseScanLogHeader(readFileSync(path, 'utf8')) };
}
