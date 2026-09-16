// Render synthetic MTG-like cards on a "photo" canvas so the whole pipeline
// (detection → warp → crops → OCR → matching) can run offline.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const out = process.argv[2];
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
const page = await browser.newPage();
await page.setContent('<canvas id="c"></canvas>');
const scenes = {
	'synth-single.jpg': { w: 1600, h: 2200, cards: [{ name: 'Lightning Bolt', type: 'Instant', text: 'Lightning Bolt deals 3 damage to any target.', num: '146/249 C', set: 'M10', cx: 800, cy: 1100, h: 1300, angle: 3, color: '#c8433a' }] },
	'synth-grid.jpg': { w: 2400, h: 2000, cards: [
		{ name: 'Lightning Bolt', type: 'Instant', text: 'Lightning Bolt deals 3 damage to any target.', num: '146/249 C', set: 'M10', cx: 650, cy: 520, h: 800, angle: -2, color: '#c8433a' },
		{ name: 'Counterspell', type: 'Instant', text: 'Counter target spell.', num: '267/303 U', set: 'MH2', cx: 1750, cy: 520, h: 800, angle: 1.5, color: '#3a6fc8' },
		{ name: 'Giant Growth', type: 'Instant', text: 'Target creature gets +3/+3 until end of turn.', num: '186/249 C', set: 'M10', cx: 650, cy: 1480, h: 800, angle: 0.5, color: '#3aa05a' },
		{ name: 'Lightning Helix', type: 'Instant', text: 'Lightning Helix deals 3 damage to any target and you gain 3 life.', num: '208/291 U', set: 'RVR', cx: 1750, cy: 1480, h: 800, angle: -1, color: '#c88a3a' }
	] },
	'synth-sideways.jpg': { w: 2200, h: 1600, cards: [{ name: 'Counterspell', type: 'Instant', text: 'Counter target spell.', num: '267/303 U', set: 'MH2', cx: 1100, cy: 800, h: 1200, angle: 90, color: '#3a6fc8' }] }
};
for (const [file, scene] of Object.entries(scenes)) {
	const dataUrl = await page.evaluate((scene) => {
		const c = document.getElementById('c'); c.width = scene.w; c.height = scene.h;
		const ctx = c.getContext('2d');
		ctx.fillStyle = '#f2f0ec'; ctx.fillRect(0, 0, scene.w, scene.h);
		// faint paper texture
		for (let i = 0; i < 4000; i++) { ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.04})`; ctx.fillRect(Math.random() * scene.w, Math.random() * scene.h, 3, 3); }
		for (const card of scene.cards) {
			const H = card.h, W = Math.round(H * 0.716);
			ctx.save(); ctx.translate(card.cx, card.cy); ctx.rotate((card.angle * Math.PI) / 180); ctx.translate(-W / 2, -H / 2);
			const r = (f) => Math.round(H * f);
			// black border with rounded corners
			ctx.fillStyle = '#111'; ctx.beginPath(); ctx.roundRect(0, 0, W, H, r(0.03)); ctx.fill();
			// coloured frame
			ctx.fillStyle = card.color; ctx.fillRect(r(0.028), r(0.028), W - 2 * r(0.028), H - 2 * r(0.028));
			// name bar
			ctx.fillStyle = '#f4efe2'; ctx.fillRect(r(0.045), r(0.045), W - 2 * r(0.045), r(0.055));
			ctx.fillStyle = '#111'; ctx.font = `bold ${r(0.036)}px "DejaVu Serif", serif`; ctx.textBaseline = 'middle';
			ctx.fillText(card.name, r(0.06), r(0.0725));
			// mana symbol
			ctx.beginPath(); ctx.arc(W - r(0.08), r(0.0725), r(0.018), 0, Math.PI * 2); ctx.fillStyle = '#ddd'; ctx.fill();
			// art
			const g = ctx.createLinearGradient(0, r(0.11), 0, r(0.52)); g.addColorStop(0, '#5a5f8a'); g.addColorStop(1, '#1e2340');
			ctx.fillStyle = g; ctx.fillRect(r(0.045), r(0.11), W - 2 * r(0.045), r(0.41));
			ctx.fillStyle = 'rgba(255,220,120,0.8)'; ctx.beginPath(); ctx.arc(W / 2, r(0.3), r(0.09), 0, Math.PI * 2); ctx.fill();
			// type line
			ctx.fillStyle = '#f4efe2'; ctx.fillRect(r(0.045), r(0.535), W - 2 * r(0.045), r(0.045));
			ctx.fillStyle = '#111'; ctx.font = `bold ${r(0.028)}px "DejaVu Serif", serif`; ctx.fillText(card.type, r(0.06), r(0.5575));
			// text box
			ctx.fillStyle = '#f8f5ee'; ctx.fillRect(r(0.045), r(0.59), W - 2 * r(0.045), r(0.3));
			ctx.fillStyle = '#111'; ctx.font = `${r(0.026)}px "DejaVu Serif", serif`;
			const words = card.text.split(' '); let line = '', y = r(0.625);
			for (const w of words) { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > W - 2 * r(0.075)) { ctx.fillText(line, r(0.065), y); line = w; y += r(0.036); } else line = t; }
			if (line) ctx.fillText(line, r(0.065), y);
			// collector info (two lines, bottom left, light on dark like real cards)
			ctx.fillStyle = '#eee'; ctx.font = `${r(0.0165)}px "DejaVu Sans", sans-serif`;
			ctx.fillText(card.num, r(0.05), r(0.925));
			ctx.fillText(`${card.set} • EN`, r(0.05), r(0.951));
			ctx.fillText('™ & © 2009 Wizards of the Coast', W - r(0.36), r(0.951));
			ctx.restore();
		}
		return c.toDataURL('image/jpeg', 0.9);
	}, scene);
	writeFileSync(`${out}/${file}`, Buffer.from(dataUrl.split(',')[1], 'base64'));
	console.log('wrote', file, scene.w + 'x' + scene.h, scene.cards.length, 'card(s)');
}
await browser.close();
