/** Detect a persistent card replacement, including at the same position. No DOM or OpenCV. */
import { orderCornersForCard } from './geometry';
import { dctHash, hammingDistance, HASH_SIZE } from './phash';
import { sceneDiffers, type TrackableRect } from './stability';

/** `samples` is the 32x32 gray grid the hashes come from (in card coordinates). */
export type ContentFingerprint = { hash: string; rotatedHash: string; samples?: Float32Array };
export type ContentRect = TrackableRect & { fingerprint?: ContentFingerprint; corners?: Array<[number, number]> };

// On the 15 reference cards, outline perturbations of the same card reached 24 bits.
// Prefer a missed replacement (manual/move fallback) over repeating the previous card.
export const CONTENT_CHANGE_BITS = 26;
// Correlation of the gray samples at the captured corners in a later frame. The hash is no good
// for this: on smooth content a few grey levels of sensor noise flip half its bits. A card that is
// still there correlates almost perfectly (gain and offset of the exposure drop out), the
// background left where it was taken away does not.
export const STILL_IN_PLACE_CORRELATION = 0.8;

/** Sample the card in its own coordinates, ignoring its background and overall brightness. */
export function cardFingerprint(rgba: ArrayLike<number>, width: number, height: number, corners: Array<[number, number]>): ContentFingerprint {
	const gray = cardSamples(rgba, width, height, corners);
	return { hash: dctHash(gray), rotatedHash: dctHash(gray.slice().reverse()), samples: gray };
}

/** 32x32 gray samples (3x3 means) over the card's inner 80% in its own coordinates. */
export function cardSamples(rgba: ArrayLike<number>, width: number, height: number, corners: Array<[number, number]>): Float32Array {
	const q = orderCornersForCard(corners);
	const gray = new Float32Array(HASH_SIZE * HASH_SIZE);
	for (let y = 0; y < HASH_SIZE; y++) for (let x = 0; x < HASH_SIZE; x++) {
		const u = 0.1 + 0.8 * (x + 0.5) / HASH_SIZE;
		const v = 0.12 + 0.76 * (y + 0.5) / HASH_SIZE;
		const tx = q[0][0] + (q[1][0] - q[0][0]) * u, ty = q[0][1] + (q[1][1] - q[0][1]) * u;
		const bx = q[3][0] + (q[2][0] - q[3][0]) * u, by = q[3][1] + (q[2][1] - q[3][1]) * u;
		const px = Math.round(tx + (bx - tx) * v), py = Math.round(ty + (by - ty) * v);
		let sum = 0;
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			const i = (Math.max(0, Math.min(height - 1, py + dy)) * width + Math.max(0, Math.min(width - 1, px + dx))) * 4;
			sum += rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114;
		}
		gray[y * HASH_SIZE + x] = sum / 9;
	}
	return gray;
}

/** Pearson correlation; 0 for a flat grid, which proves nothing. */
function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number {
	const n = Math.min(a.length, b.length);
	if (n === 0) return 0;
	let ma = 0, mb = 0;
	for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
	ma /= n; mb /= n;
	let sab = 0, saa = 0, sbb = 0;
	for (let i = 0; i < n; i++) {
		const da = a[i] - ma, db = b[i] - mb;
		sab += da * db; saa += da * da; sbb += db * db;
	}
	return saa > 1e-6 && sbb > 1e-6 ? sab / Math.sqrt(saa * sbb) : 0;
}

/**
 * Whether every captured card still lies where it was captured, judged from the pixels at its
 * captured corners rather than from the detector. `coordScale` maps analysis-frame pixels to
 * the captured coordinates (the detector's `coordScale`).
 */
export function capturedStillInPlace(captured: ContentRect[], rgba: ArrayLike<number>, width: number, height: number, coordScale = 1): boolean {
	const inv = 1 / coordScale;
	return captured.length > 0 && captured.every((c) => !!c.corners && !!c.fingerprint?.samples
		&& correlation(c.fingerprint.samples, cardSamples(rgba, width, height, c.corners.map(([x, y]) => [x * inv, y * inv]))) >= STILL_IN_PLACE_CORRELATION);
}

export function contentDistance(a: ContentFingerprint, b: ContentFingerprint): number {
	return Math.min(hammingDistance(a.hash, b.hash), hammingDistance(a.hash, b.rotatedHash));
}

/** Pair cards by centre so detection order does not change the content comparison. */
function paired(captured: ContentRect[], current: ContentRect[]): Array<[ContentRect, ContentRect]> {
	const remaining = new Set(current);
	return captured.map((a) => {
		const ax = a.rect.x + a.rect.width / 2, ay = a.rect.y + a.rect.height / 2;
		const b = [...remaining].sort((b, c) => {
			const distance = (r: ContentRect) => Math.hypot(r.rect.x + r.rect.width / 2 - ax, r.rect.y + r.rect.height / 2 - ay);
			return distance(b) - distance(c);
		})[0];
		remaining.delete(b);
		return [a, b];
	});
}

const snapshot = (rects: ContentRect[]) => rects.map((r) => ({
	rect: { ...r.rect },
	fingerprint: r.fingerprint ? { ...r.fingerprint, samples: r.fingerprint.samples?.slice() } : undefined,
	corners: r.corners?.map(([x, y]) => [x, y] as [number, number])
}));

/** Every detected rectangle lies on a captured card: a changed outline, not a new card. */
function onCapturedCards(captured: ContentRect[], rects: ContentRect[]): boolean {
	return rects.every((r) => {
		const cx = r.rect.x + r.rect.width / 2, cy = r.rect.y + r.rect.height / 2;
		return captured.some((c) => cx >= c.rect.x && cx <= c.rect.x + c.rect.width && cy >= c.rect.y && cy <= c.rect.y + c.rect.height);
	});
}

/** Cached pixels can replace the current frame only when every card still has the same content. */
export function sameCardContent(a: ContentRect[], b: ContentRect[]): boolean {
	return a.length > 0 && a.length === b.length
		&& paired(a, b).every(([x, y]) => x.fingerprint && y.fingerprint && contentDistance(x.fingerprint, y.fingerprint) <= 8);
}

export class CaptureRearm {
	private captured: ContentRect[] | null = null;
	private pending: { kind: 'layout' | 'content'; since: number; samples: number; rects: ContentRect[] } | null = null;
	private observation = 'not observed';
	get waiting(): boolean { return this.captured !== null; }
	/** The cards of the last capture, for the caller's in-place check. */
	get baseline(): readonly ContentRect[] | null { return this.captured; }
	/** Text-only diagnostics; distances describe image changes, never card identities. */
	describe(now: number): string {
		if (!this.captured) return 'armed';
		const p = this.pending;
		return `${this.observation}${p ? `; pending ${p.kind} ${p.samples} samples / ${Math.round(now - p.since)} ms` : '; no persistent change'}`;
	}

	/** The baseline must describe the frame actually handed to OCR, including its best-frame content. */
	capture(rects: ContentRect[]): void { this.captured = snapshot(rects); this.resetObservation(); }
	reset(): void { this.captured = null; this.resetObservation(); }
	resetObservation(): void { this.pending = null; this.observation = 'not observed'; }

	/**
	 * Null means no replacement. Invalid detections and brief occlusions never rearm, and neither
	 * does a detection that loses or re-outlines a card the caller still sees in place
	 * (`stillInPlace`, from capturedStillInPlace()).
	 */
	update(rects: ContentRect[], now: number, opts: { valid?: boolean; contentEligible?: boolean; stillInPlace?: boolean } = {}): 'layout' | 'content' | null {
		if (!this.captured) return null;
		if (opts.valid === false) { this.observation = 'invalid detection'; this.pending = null; return null; }
		let kind: 'layout' | 'content' | null = null;
		if (sceneDiffers(this.captured, rects)) {
			kind = 'layout';
			this.observation = `layout changed (${this.captured.length} -> ${rects.length} rectangles)`;
		} else {
			const pairs = paired(this.captured, rects);
			const distances = pairs.flatMap(([a, b]) => a.fingerprint && b.fingerprint ? [contentDistance(a.fingerprint, b.fingerprint)] : []);
			const max = distances.length ? Math.max(...distances) : null;
			this.observation = `content max=${max ?? 'unavailable'}/${CONTENT_CHANGE_BITS} bits, fingerprints=${distances.length}/${pairs.length}, eligible=${opts.contentEligible !== false}`;
			if (opts.contentEligible !== false && max !== null && max >= CONTENT_CHANGE_BITS) kind = 'content';
		}
		// The pixels where the card was captured are unchanged: whatever the detector reports now
		// (nothing, or another outline of the same thing), the card has not been replaced.
		if (kind && opts.stillInPlace && onCapturedCards(this.captured, rects)) {
			this.observation += '; captured card still in place';
			kind = null;
		}
		if (!kind) { this.pending = null; return null; }
		const p = this.pending;
		const consistent = p && p.kind === kind && !sceneDiffers(p.rects, rects)
			&& (kind !== 'content' || paired(p.rects, rects).every(([a, b]) => a.fingerprint && b.fingerprint && contentDistance(a.fingerprint, b.fingerprint) <= 8));
		if (!consistent) this.pending = { kind, since: now, samples: 1, rects: snapshot(rects) };
		else p.samples++;
		const pending = this.pending!;
		if (pending.samples < 3 || now - pending.since < (kind === 'content' ? 700 : 300)) return null;
		this.reset();
		return kind;
	}
}
