// Run one photo through /scan and dump the detection debug image + per-card crops as a montage PNG.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
const [file, outDir, mode = 'multiple'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto('http://127.0.0.1:5173/scan', { waitUntil: 'networkidle' });
await page.getByRole('button', { name: mode === 'single' ? 'Single card' : 'Multiple cards' }).click();
await page.setInputFiles('input[type=file]', file);
await page.waitForFunction(() => /Scan complete:|No cards detected|Error:/.test(document.querySelector('pre')?.textContent ?? ''), null, { timeout: 600000 });
const data = await page.evaluate(() => {
	const detection = document.querySelector('details img')?.getAttribute('src') ?? null;
	const cards = Array.from(document.querySelectorAll('h3')).filter((h) => /^Card \d+/.test(h.innerText.trim())).map((h) => {
		const b = h.closest('.rounded-lg');
		const imgs = Array.from(b.querySelectorAll('img')).map((i) => i.getAttribute('src'));
		const mono = Array.from(b.querySelectorAll('p.font-mono')).map((p) => p.innerText.trim());
		const chosen = b.querySelector('p.font-semibold');
		return { title: h.innerText.trim().split('\n')[0].replace(/\s+/g, ' '), crop: imgs[0], name: imgs[1], bottom: imgs[2], nameText: mono[0] ?? '', bottomText: mono[1] ?? '', result: chosen ? chosen.innerText.trim() : '—' };
	});
	return { detection, cards };
});
const tag = basename(file).replace(/[^A-Za-z0-9_.-]/g, '_');
if (data.detection) writeFileSync(`${outDir}/${tag}-detection.jpg`, Buffer.from(data.detection.split(',')[1], 'base64'));
// montage: one row per card
const rows = data.cards.map((c) => `<tr><td style="font:12px monospace;white-space:pre">${c.title}\n=> ${c.result}\nname: ${c.nameText.slice(0, 40)}\nbottom: ${c.bottomText.slice(0, 40)}</td><td><img src="${c.crop}" style="height:150px"></td><td><img src="${c.name}" style="height:60px"></td><td><img src="${c.bottom}" style="height:80px"></td></tr>`).join('');
await page.setContent(`<body style="margin:6px;background:#fff"><table style="border-collapse:collapse">${rows}</table></body>`);
await page.screenshot({ path: `${outDir}/${tag}-crops.png`, fullPage: true });
console.log(`dumped ${data.cards.length} cards for ${basename(file)} -> ${outDir}`);
await browser.close();
