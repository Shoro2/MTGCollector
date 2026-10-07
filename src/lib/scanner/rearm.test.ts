import { describe, expect, it } from 'vitest';
import { CaptureRearm, cardFingerprint, contentDistance, sameCardContent, type ContentRect } from './rearm';

const a = { hash: '0000ffffffff0000', rotatedHash: '0000ffffffff0000' };
const b = { hash: 'ffff00000000ffff', rotatedHash: 'ffff00000000ffff' };
const card = (fingerprint = a, x = 100): ContentRect => ({ rect: { x, y: 100, width: 200, height: 280 }, fingerprint });

it('rejects a best frame of the previous card, including manual captures with auto-capture off', () => {
	expect(sameCardContent([card()], [card(b)])).toBe(false);
	expect(sameCardContent([card()], [card(a, 103)])).toBe(true);
	expect(sameCardContent([], [])).toBe(false);
	expect(sameCardContent([card()], [])).toBe(false);
	expect(sameCardContent([card()], [{ rect: card().rect }])).toBe(false);
	expect(sameCardContent([card(a, 100), card(b, 500)], [card(b, 500), card(a, 100)])).toBe(true);
});

describe('CaptureRearm', () => {
	it('does not rearm on a persistent changed outline of the same real card', () => {
		// Orcish Bowmasters LTR #433, independent ±2% corner errors in the reference experiment.
		const first = { hash: '49e8c4e4c89d78ea', rotatedHash: '3c46914e9d372f42' };
		const shifted = { hash: '6ce0e6eccc7d2a80', rotatedHash: '3842b3449bd57f11' };
		expect(contentDistance(first, shifted)).toBe(18);
		const r = new CaptureRearm(); r.capture([card(first)]);
		for (const t of [0, 166, 333, 500, 666, 833, 1000, 1200]) expect(r.update([card(shifted)], t)).toBeNull();
		expect(r.waiting).toBe(true);
	});
	it('notices a persistent different card at unchanged corners while the caller is processing OCR', () => {
		const r = new CaptureRearm();
		r.capture([card()]);
		for (const t of [0, 166, 333, 500, 666]) expect(r.update([card(b)], t)).toBeNull();
		expect(r.update([card(b)], 833)).toBe('content');
		expect(r.waiting).toBe(false);
		r.capture([card(b)]);
		expect(r.update([card(b)], 2000)).toBeNull();
		expect(r.waiting).toBe(true);
	});
	it('keeps the capture baseline independent of later mutations', () => {
		const original = card();
		const r = new CaptureRearm(); r.capture([original]);
		original.rect.x = 600; original.fingerprint = b;
		expect(r.update([card()], 0)).toBeNull();
		expect(r.update([card()], 1000)).toBeNull();
	});
	it('ignores hand jitter, minor hash changes and transient occlusion', () => {
		const r = new CaptureRearm(); r.capture([card()]);
		const minor = { ...a, hash: '0000ffffffff0003' };
		for (let t = 0; t < 3000; t += 166) expect(r.update([card(minor, 108)], t)).toBeNull();
		r.update([card(b)], 3000); r.update([card(b)], 3166);
		expect(r.update([card()], 3333)).toBeNull();
		expect(r.waiting).toBe(true);
	});
	it('does not rearm on failures or one missed detection; requires an observed absence', () => {
		const r = new CaptureRearm(); r.capture([card()]);
		for (let t = 0; t < 2000; t += 166) expect(r.update([], t, { valid: false })).toBeNull();
		r.update([], 2100); r.update([], 2266);
		expect(r.update([card()], 2433)).toBeNull();
		r.update([], 2600); r.update([], 2766);
		expect(r.update([], 2933)).toBe('layout');
	});
	it('allows moving or removing and reinserting the same card', () => {
		const r = new CaptureRearm(); r.capture([card()]);
		r.update([card(a, 230)], 0); r.update([card(a, 230)], 166);
		expect(r.update([card(a, 230)], 333)).toBe('layout');
	});
	it('preserves the last capture through pause/resume but restarts observation', () => {
		const r = new CaptureRearm(); r.capture([card()]);
		r.update([card(b)], 0); r.update([card(b)], 333); r.resetObservation();
		expect(r.update([card(b)], 10_000)).toBeNull();
		expect(r.waiting).toBe(true);
		expect(r.update([card()], 10_166)).toBeNull();
	});
	it('requires eligible, consistent content; changing glare and unstable hands do not accumulate', () => {
		const r = new CaptureRearm(); r.capture([card()]);
		for (let t = 0; t < 2000; t += 166) expect(r.update([card(b)], t, { contentEligible: false })).toBeNull();
		r.update([card(b)], 2100); r.update([card(b)], 2266);
		expect(r.update([card(b)], 3000, { contentEligible: false })).toBeNull();
		expect(r.update([card(b)], 4000)).toBeNull();
	});
	it('matches content by position regardless of detection order', () => {
		const r = new CaptureRearm(); r.capture([card(a, 100), card(b, 500)]);
		for (let t = 0; t < 2000; t += 166) expect(r.update([card(b, 502), card(a, 98)], t)).toBeNull();
	});
});

describe('card content fingerprints', () => {
	const width = 100, height = 140;
	const corners: Array<[number, number]> = [[0, 0], [99, 0], [99, 139], [0, 139]];
	const pixels = (brightness = 0) => {
		const data = new Uint8ClampedArray(width * height * 4);
		for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			const l = 110 + 45 * Math.sin(x / 9) + 30 * Math.cos((x + y) / 13) + brightness;
			data[i] = data[i + 1] = data[i + 2] = l; data[i + 3] = 255;
		}
		return data;
	};
	it('tolerates exposure changes and a 180-degree rotation of the same card', () => {
		const source = pixels(), rotated = new Uint8ClampedArray(source.length);
		for (let i = 0; i < width * height; i++) rotated.set(source.subarray(i * 4, i * 4 + 4), (width * height - 1 - i) * 4);
		const base = cardFingerprint(source, width, height, corners);
		expect(contentDistance(base, cardFingerprint(pixels(25), width, height, corners))).toBeLessThanOrEqual(2);
		expect(contentDistance(base, cardFingerprint(rotated, width, height, corners))).toBeLessThanOrEqual(2);
	});
});
