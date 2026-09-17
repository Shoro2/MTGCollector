// Turn a still image into a Y4M clip for live-harness.mjs (Chromium's fake
// camera), so the live scanner can be driven with a real photo or a scene from
// make-mat-scenes.mjs instead of the synthetic two-card fixture.
//
//   node scripts/scanner-harness/make-still-y4m.mjs photo.jpg out.y4m [--frames 18]
//
// The image is fitted into a 1920x1080 landscape frame (Chromium crops
// portrait clips when the app asks for 1920x1080) and the sides are filled by
// repeating the edge pixels, so the background continues without bars (mirroring
// would show a second, mirrored copy of a card that lies near the edge).
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';

const [input, out, ...rest] = process.argv.slice(2);
if (!input || !out) throw new Error('usage: make-still-y4m.mjs <image> <out.y4m> [--frames N]');
const frames = rest[0] === '--frames' ? Number(rest[1]) : 18;
const W = 1920, H = 1080;

const fitted = await sharp(input).rotate().resize(W, H, { fit: 'inside' }).toBuffer({ resolveWithObject: true });
const padX = W - fitted.info.width, padY = H - fitted.info.height;
const { data } = await sharp(fitted.data)
	.extend({ left: Math.floor(padX / 2), right: Math.ceil(padX / 2), top: Math.floor(padY / 2), bottom: Math.ceil(padY / 2), extendWith: 'copy' })
	.removeAlpha()
	.raw()
	.toBuffer({ resolveWithObject: true });

const Y = Buffer.alloc(W * H), U = Buffer.alloc((W / 2) * (H / 2)), V = Buffer.alloc((W / 2) * (H / 2));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
for (let y = 0; y < H; y++) {
	for (let x = 0; x < W; x++) {
		const i = (y * W + x) * 3, R = data[i], G = data[i + 1], B = data[i + 2];
		Y[y * W + x] = clamp(0.257 * R + 0.504 * G + 0.098 * B + 16, 16, 235);
		if ((x & 1) === 0 && (y & 1) === 0) {
			const j = (y / 2) * (W / 2) + x / 2;
			U[j] = clamp(-0.148 * R - 0.291 * G + 0.439 * B + 128, 16, 240);
			V[j] = clamp(0.439 * R - 0.368 * G - 0.071 * B + 128, 16, 240);
		}
	}
}
const parts = [Buffer.from(`YUV4MPEG2 W${W} H${H} F6:1 Ip A1:1 C420jpeg\n`)];
for (let f = 0; f < frames; f++) parts.push(Buffer.from('FRAME\n'), Y, U, V);
writeFileSync(out, Buffer.concat(parts));
console.log(`wrote ${out}: ${W}x${H}, ${frames} frames from ${input}`);
