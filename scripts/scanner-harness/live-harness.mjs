// Feed a Y4M clip as the camera and let /scan's live mode auto-capture + identify.
import { chromium } from 'playwright';
const y4m = process.argv[2];
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['camera'] });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:5173/scan', { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Live camera' }).click();
const t0 = Date.now();
// Wait for the pipeline to finish (the debug log is authoritative; it is inside a collapsed <details>, hence textContent).
await page.waitForFunction(() => /Scan complete:|No cards detected|Error:/.test(document.querySelector('pre')?.textContent ?? '') || /Error:/.test(document.body.innerText), null, { timeout: 120000 });
const wall = (Date.now() - t0) / 1000;
const log = await page.evaluate(() => document.querySelector('pre')?.textContent ?? '');
const badge = await page.evaluate(() => document.body.innerText.match(/\d+ cards? · steady \d+%[^\n]*/)?.[0] ?? '');
const liveLines = log.split('\n').filter((l) => /\[live\]|Live capture|Using \d+ rectangle|Scan complete|Stream/.test(l));
console.log(`live: identified after ${wall.toFixed(1)}s; badge="${badge}"`);
for (const l of liveLines) console.log('  ' + l.trim());
const cards = await page.evaluate(() => Array.from(document.querySelectorAll('h3')).filter((h) => /^Card \d+/.test(h.innerText.trim())).map((h) => { const b = h.closest('.rounded-lg'); const p = b.querySelector('p.font-semibold'); return `${h.innerText.trim().split('\n')[0].replace(/\s+/g, ' ')} -> ${p ? p.innerText.trim() + ' / ' + (p.nextElementSibling?.innerText.trim() ?? '') : 'NOT IDENTIFIED'}`; }));
for (const c of cards) console.log('  ' + c);
await page.screenshot({ path: process.argv[3] || 'live-result.png' });
console.log('errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
