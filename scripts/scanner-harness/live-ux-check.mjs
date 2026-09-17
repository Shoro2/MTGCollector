// Live scanner UX check: capture / result cues, pause (review) mode, resume.
//
//   node scripts/scanner-harness/live-ux-check.mjs clip.y4m [screenshot-prefix]
//
// Plays a Y4M clip as the camera (like live-harness.mjs), records every
// navigator.vibrate() pattern and every oscillator the page starts, and then
// walks through the review flow: scan -> pause (camera released, viewfinder
// collapsed, results still there) -> resume (no second capture of the card
// that is still lying there). Exits 1 when an expectation fails.
import { chromium } from 'playwright';

const [y4m, shot = 'live-ux'] = process.argv.slice(2);
if (!y4m) throw new Error('usage: live-ux-check.mjs <clip.y4m> [screenshot-prefix]');
const url = `${process.env.HARNESS_URL ?? 'http://localhost:5173'}/scan`;
const browser = await chromium.launch({
	executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
	args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`]
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['camera'] });
await context.addInitScript(() => {
	window.__cues = { vibrate: [], tones: [] };
	navigator.vibrate = (p) => { window.__cues.vibrate.push(Array.isArray(p) ? p : [p]); return true; };
	const AC = window.AudioContext;
	if (AC) {
		const create = AC.prototype.createOscillator;
		AC.prototype.createOscillator = function () {
			const osc = create.call(this);
			const start = osc.start.bind(osc);
			osc.start = (t) => { window.__cues.tones.push(Math.round(osc.frequency.value)); return start(t); };
			return osc;
		};
	}
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const failures = [];
const expect = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };
const status = () => page.evaluate(() => document.querySelector('[data-status]')?.getAttribute('data-status'));
const cardCount = () => page.evaluate(() => Array.from(document.querySelectorAll('h3')).filter((h) => /^Card \d+/.test(h.innerText.trim())).length);
const cameraOn = () => page.evaluate(() => { const v = document.querySelector('video'); return !!(v && v.srcObject && v.srcObject.getTracks().some((t) => t.readyState === 'live')); });

await page.goto(url, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Live camera' }).click();
await page.waitForFunction(() => /Scan complete:|No cards detected|Error:/.test(document.querySelector('pre')?.textContent ?? ''), null, { timeout: 120000 });
await page.waitForTimeout(400);

const cues = await page.evaluate(() => window.__cues);
const cards = await cardCount();
expect(cards >= 1, `a card was captured and listed (${cards})`);
expect(JSON.stringify(cues.vibrate[0]) === '[35]', `capture cue vibrates first (${JSON.stringify(cues.vibrate)})`);
expect(cues.vibrate.length === 2 && cues.vibrate[1].length >= 1, 'a result cue follows the capture cue');
expect(cues.tones[0] === 880 && cues.tones.length >= 2, `capture tick, then result tone(s) (${JSON.stringify(cues.tones)})`);
expect(await cameraOn(), 'camera is live while scanning');

// ---- pause: review mode ----
await page.getByRole('button', { name: 'Pause camera' }).click();
await page.waitForTimeout(300);
expect((await status()) === 'paused', 'status is paused');
expect(!(await cameraOn()), 'camera track is stopped (indicator off)');
expect(await page.getByText('Camera paused').isVisible(), 'the paused panel is shown');
expect(!(await page.locator('video').isVisible()), 'the viewfinder is collapsed');
expect((await cardCount()) === cards, 'the scanned cards are still listed');
await page.screenshot({ path: `${shot}-paused.png` });

// ---- resume: same card still in view -> no second capture ----
await page.getByRole('button', { name: 'Resume camera' }).click();
await page.waitForFunction(() => document.querySelector('[data-status]')?.getAttribute('data-status') === 'live', null, { timeout: 60000 });
expect(await cameraOn(), 'camera is live again after resume');
await page.waitForTimeout(4000);
expect((await cardCount()) === cards, `no second capture of the card that stayed in view (${await cardCount()})`);
const after = await page.evaluate(() => window.__cues);
expect(after.vibrate.length === cues.vibrate.length, 'no further cues after resume');
await page.screenshot({ path: `${shot}-resumed.png` });

// ---- preferences: switching the sound off silences the next cue and sticks ----
const before = (await page.evaluate(() => window.__cues.tones.length));
await page.getByLabel('Sound').uncheck();
await page.getByRole('button', { name: 'Capture now' }).click();
await page.waitForTimeout(1500);
expect((await page.evaluate(() => window.__cues.tones.length)) === before, 'no tone with the sound switched off');
expect((await page.evaluate(() => localStorage.getItem('mtg.scan.feedback')))?.includes('"sound":false'), 'the preference is stored');

console.log('page errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
if (failures.length || errors.length) process.exit(1);
