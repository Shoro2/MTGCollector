// Render a portrait "phone camera" scene (1080x1920) with synthetic cards and
// write it as a Y4M clip for Chromium's --use-file-for-fake-video-capture.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const out = process.argv[2];
const W = 1920, H = 1080, FRAMES = 12;
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
const page = await browser.newPage();
await page.setContent('<canvas id="c"></canvas>');
const yuv = await page.evaluate(({ W, H }) => {
	const c = document.getElementById('c'); c.width = W; c.height = H;
	const ctx = c.getContext('2d');
	ctx.fillStyle = '#d9d4cc'; ctx.fillRect(0, 0, W, H); // wooden-table-ish grey
	const cards = [
		{ name: 'Lightning Bolt', type: 'Instant', text: 'Lightning Bolt deals 3 damage to any target.', num: '146/249 C', set: 'M10', cx: 620, cy: 540, h: 900, angle: 2, color: '#c8433a' },
		{ name: 'Counterspell', type: 'Instant', text: 'Counter target spell.', num: '267/303 U', set: 'MH2', cx: 1360, cy: 540, h: 760, angle: -3, color: '#3a6fc8' }
	];
	for (const card of cards) {
		const CH = card.h, CW = Math.round(CH * 0.716);
		ctx.save(); ctx.translate(card.cx, card.cy); ctx.rotate((card.angle * Math.PI) / 180); ctx.translate(-CW / 2, -CH / 2);
		const r = (f) => Math.round(CH * f);
		ctx.fillStyle = '#111'; ctx.beginPath(); ctx.roundRect(0, 0, CW, CH, r(0.03)); ctx.fill();
		ctx.fillStyle = card.color; ctx.fillRect(r(0.028), r(0.028), CW - 2 * r(0.028), CH - 2 * r(0.028));
		ctx.fillStyle = '#f4efe2'; ctx.fillRect(r(0.045), r(0.045), CW - 2 * r(0.045), r(0.055));
		ctx.fillStyle = '#111'; ctx.font = `bold ${r(0.036)}px "DejaVu Serif", serif`; ctx.textBaseline = 'middle';
		ctx.fillText(card.name, r(0.06), r(0.0725));
		const g = ctx.createLinearGradient(0, r(0.11), 0, r(0.52)); g.addColorStop(0, '#5a5f8a'); g.addColorStop(1, '#1e2340');
		ctx.fillStyle = g; ctx.fillRect(r(0.045), r(0.11), CW - 2 * r(0.045), r(0.41));
		ctx.fillStyle = '#f4efe2'; ctx.fillRect(r(0.045), r(0.535), CW - 2 * r(0.045), r(0.045));
		ctx.fillStyle = '#111'; ctx.font = `bold ${r(0.028)}px "DejaVu Serif", serif`; ctx.fillText(card.type, r(0.06), r(0.5575));
		ctx.fillStyle = '#f8f5ee'; ctx.fillRect(r(0.045), r(0.59), CW - 2 * r(0.045), r(0.3));
		ctx.fillStyle = '#111'; ctx.font = `${r(0.026)}px "DejaVu Serif", serif`; ctx.fillText(card.text.slice(0, 34), r(0.065), r(0.625));
		ctx.fillStyle = '#eee'; ctx.font = `${r(0.0165)}px "DejaVu Sans", sans-serif`;
		ctx.fillText(card.num, r(0.05), r(0.925)); ctx.fillText(`${card.set} • EN`, r(0.05), r(0.951));
		ctx.restore();
	}
	const { data } = ctx.getImageData(0, 0, W, H);
	const Y = new Uint8Array(W * H), U = new Uint8Array((W / 2) * (H / 2)), V = new Uint8Array((W / 2) * (H / 2));
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		const i = (y * W + x) * 4, R = data[i], G = data[i + 1], B = data[i + 2];
		Y[y * W + x] = Math.max(16, Math.min(235, Math.round(0.257 * R + 0.504 * G + 0.098 * B + 16)));
		if ((x & 1) === 0 && (y & 1) === 0) {
			const j = (y / 2) * (W / 2) + x / 2;
			U[j] = Math.max(16, Math.min(240, Math.round(-0.148 * R - 0.291 * G + 0.439 * B + 128)));
			V[j] = Math.max(16, Math.min(240, Math.round(0.439 * R - 0.368 * G - 0.071 * B + 128)));
		}
	}
	const b64 = (arr) => { let s = ''; for (let i = 0; i < arr.length; i += 0x8000) s += String.fromCharCode.apply(null, arr.subarray(i, i + 0x8000)); return btoa(s); };
	return { Y: b64(Y), U: b64(U), V: b64(V) };
}, { W, H });
const Y = Buffer.from(yuv.Y, 'base64'), U = Buffer.from(yuv.U, 'base64'), V = Buffer.from(yuv.V, 'base64');
const parts = [Buffer.from(`YUV4MPEG2 W${W} H${H} F6:1 Ip A1:1 C420jpeg\n`)];
for (let f = 0; f < FRAMES; f++) parts.push(Buffer.from('FRAME\n'), Y, U, V);
writeFileSync(out, Buffer.concat(parts));
console.log('wrote', out, `${W}x${H}`, FRAMES, 'frames');
await browser.close();
