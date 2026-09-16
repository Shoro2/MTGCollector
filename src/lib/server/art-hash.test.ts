import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { hashImageBytes, smallImageUrl } from './art-hash';
import { ART_BOX, hashArtPixels } from '../scanner/phash';

describe('art-hash job', () => {
	it('derives the small rendition from the stored image URL', () => {
		expect(smallImageUrl('https://cards.scryfall.io/normal/front/0/0/0000.jpg?123')).toBe('https://cards.scryfall.io/small/front/0/0/0000.jpg?123');
	});

	it('hashes an encoded image exactly like the shared pipeline hashes its raw art-box pixels', async () => {
		// A 146x204 "card" with a gradient and a bright blob, encoded as PNG (lossless).
		const w = 146, h = 204;
		const rgba = Buffer.alloc(w * h * 4);
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			const p = (y * w + x) * 4;
			const blob = Math.exp(-((x - 70) ** 2 + (y - 60) ** 2) / 400) * 200;
			rgba[p] = Math.min(255, x + blob);
			rgba[p + 1] = Math.min(255, y / 2 + blob);
			rgba[p + 2] = Math.min(255, 255 - x + blob / 2);
			rgba[p + 3] = 255;
		}
		const png = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
		const viaJob = await hashImageBytes(png);
		const box = { left: Math.round(w * ART_BOX.x), top: Math.round(h * ART_BOX.y), width: Math.round(w * ART_BOX.w), height: Math.round(h * ART_BOX.h) };
		const cut = Buffer.alloc(box.width * box.height * 4);
		for (let y = 0; y < box.height; y++) for (let x = 0; x < box.width; x++) {
			const src = ((box.top + y) * w + (box.left + x)) * 4;
			const dst = (y * box.width + x) * 4;
			cut[dst] = rgba[src]; cut[dst + 1] = rgba[src + 1]; cut[dst + 2] = rgba[src + 2]; cut[dst + 3] = 255;
		}
		expect(viaJob).toBe(hashArtPixels(cut, box.width, box.height, 4));
	});
});
