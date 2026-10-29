/**
 * Captures made without a connection, kept in IndexedDB until they can be
 * identified (CLAUDE.md §6.5). A capture is the image (a live frame as JPEG,
 * or the uploaded photo as it is), the rectangles the live detector tracked on
 * it, the scan mode and the capture's session presets. When the connection is
 * back the scan page runs each one through the normal pipeline, so an offline
 * capture is identified by exactly the same rules as an online one.
 *
 * The queue belongs to the browser profile, not to an account; nothing in it
 * leaves the device until it is identified, and then only what an online scan
 * sends (recognised text and the artwork fingerprint, never the image).
 */
import type { QuickRect } from '../scanner/quick-rects';
import type { ScanSession } from '../scanner/session';

export type QueuedMode = 'single' | 'multiple' | 'rows' | 'live';
export type QueuedScan = {
	id?: number;
	/** ISO time of the capture. */
	createdAt: string;
	mode: QueuedMode;
	image: Blob;
	/** Rectangles the live detector tracked on this frame (empty for uploads: full detection runs). */
	rects: QuickRect[];
	session: ScanSession;
	/** Identification attempts that failed for a reason other than the connection. */
	attempts: number;
};

/** Captures held at most; beyond it a new offline capture is refused (about 0.5 MB each). */
export const QUEUE_LIMIT = 300;
/** A capture whose identification failed this often (not for the connection) is skipped by automatic runs. */
export const MAX_ATTEMPTS = 3;

const DB_NAME = 'mtg-scan-queue';
const STORE = 'scans';

const isPoint = (p: unknown): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === 'number' && Number.isFinite(v));

/** A stored record as a QueuedScan, or null when it is damaged or from an incompatible version. */
export function queuedScanFromRecord(raw: unknown): QueuedScan | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== 'number' || typeof r.createdAt !== 'string') return null;
	if (r.mode !== 'single' && r.mode !== 'multiple' && r.mode !== 'rows' && r.mode !== 'live') return null;
	if (typeof Blob !== 'undefined' && !(r.image instanceof Blob)) return null;
	if (!Array.isArray(r.rects) || !r.rects.every((x) => !!x && typeof x === 'object' && Array.isArray((x as QuickRect).corners) && (x as QuickRect).corners.length === 4 && (x as QuickRect).corners.every(isPoint))) return null;
	if (!r.session || typeof r.session !== 'object') return null;
	return {
		id: r.id,
		createdAt: r.createdAt,
		mode: r.mode,
		image: r.image as Blob,
		rects: r.rects as QuickRect[],
		session: r.session as ScanSession,
		attempts: typeof r.attempts === 'number' && r.attempts >= 0 ? r.attempts : 0
	};
}

/** The rectangles as plain data (the live detector's content fingerprints are not needed later). */
export function storableRects(rects: QuickRect[]): QuickRect[] {
	return rects.map((r) => ({ corners: r.corners.map(([x, y]) => [x, y] as [number, number]), rect: { ...r.rect }, area: r.area }));
}

/** Captures that an automatic run should identify now, oldest first. */
export function pendingScans(scans: QueuedScan[]): QueuedScan[] {
	return scans.filter((s) => s.attempts < MAX_ATTEMPTS).sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}

export function queueSupported(): boolean {
	return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'));
		req.onblocked = () => reject(new Error('IndexedDB blocked by another tab'));
	});
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	const db = await openDb();
	try {
		return await new Promise<T>((resolve, reject) => {
			const tx = db.transaction(STORE, mode);
			const req = run(tx.objectStore(STORE));
			let result: T;
			req.onsuccess = () => { result = req.result; };
			tx.oncomplete = () => resolve(result);
			tx.onerror = () => reject(tx.error ?? req.error ?? new Error('IndexedDB error'));
			tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted (storage full?)'));
		});
	} finally {
		db.close();
	}
}

export async function countQueuedScans(): Promise<number> {
	return withStore('readonly', (s) => s.count());
}

/** Every stored capture, oldest first; damaged records are dropped from the result. */
export async function listQueuedScans(): Promise<QueuedScan[]> {
	const raw = await withStore<unknown[]>('readonly', (s) => s.getAll());
	return raw.map(queuedScanFromRecord).filter((x): x is QueuedScan => x !== null);
}

/** Store a capture; refuses beyond QUEUE_LIMIT. Returns its id. */
export async function addQueuedScan(scan: Omit<QueuedScan, 'id' | 'attempts'>): Promise<number> {
	if ((await countQueuedScans()) >= QUEUE_LIMIT) throw new Error(`${QUEUE_LIMIT} captures are already waiting. Identify them before scanning more offline.`);
	const record = { ...scan, rects: storableRects(scan.rects), session: { ...scan.session }, attempts: 0 };
	return Number(await withStore('readwrite', (s) => s.add(record)));
}

export async function deleteQueuedScan(id: number): Promise<void> {
	await withStore('readwrite', (s) => s.delete(id));
}

export async function markQueuedScanFailed(scan: QueuedScan): Promise<void> {
	if (scan.id === undefined) return;
	await withStore('readwrite', (s) => s.put({ ...scan, attempts: scan.attempts + 1 }));
}

export async function clearQueuedScans(): Promise<void> {
	await withStore('readwrite', (s) => s.clear());
}

/** The image of a live capture: the frame as JPEG at high quality (the collector line is tiny). */
export function canvasToJpeg(canvas: HTMLCanvasElement, quality = 0.95): Promise<Blob> {
	return new Promise((resolve, reject) => {
		// toBlob takes its snapshot now, so the caller may reuse the canvas right away.
		canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The capture could not be encoded.'))), 'image/jpeg', quality);
	});
}

/** A stored live frame back on a canvas, at its original size. */
export async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
	const bitmap = await createImageBitmap(blob);
	const canvas = document.createElement('canvas');
	canvas.width = bitmap.width;
	canvas.height = bitmap.height;
	canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
	bitmap.close();
	return canvas;
}
