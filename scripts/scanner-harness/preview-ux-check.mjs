// Mount the actual CardPreview component and check its browser geometry.
// Run: node scripts/scanner-harness/preview-ux-check.mjs
// Requires Playwright Chromium or PLAYWRIGHT_CHROMIUM_PATH; no server/DB/assets.
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const svg = (w, h) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#336699"/><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 3}" fill="#f5d080"/></svg>`);
const wrapper = `<script>
import CardPreview from '${root.replaceAll('\\', '/')}/src/lib/components/CardPreview.svelte';
const portrait = ${JSON.stringify(svg(244, 340))};
const footer = ${JSON.stringify(svg(600, 200))};
</script>
<div style="position:fixed;left:20px;top:30px"><CardPreview src={portrait} alt="Portrait preview" scale={2}><button id="portrait" style="width:80px;height:110px">Portrait</button></CardPreview></div>
<div style="position:fixed;left:20px;bottom:30px"><CardPreview src={footer} alt="Footer preview" maxWidth={600} maxHeight={200} contain><button id="footer" style="width:110px;height:45px">Footer</button></CardPreview></div>
<div style="position:fixed;right:5px;bottom:5px"><CardPreview src={portrait} alt="Edge preview" scale={2}><button id="edge">Edge</button></CardPreview></div>`;
const bundle = await build({
 stdin: { contents: "import { mount, unmount } from 'svelte'; import App from 'preview-wrapper'; const app=mount(App,{target:document.body}); window.unmountPreviewApp=()=>unmount(app);", resolveDir: root },
 bundle: true, write: false, format: 'iife', platform: 'browser', conditions: ['browser'],
 plugins: [{name:'preview-components', setup(b) {
  b.onResolve({filter:/^preview-wrapper$/}, () => ({path:'wrapper',namespace:'test'}));
  b.onLoad({filter:/.*/,namespace:'test'}, () => ({contents:compile(wrapper,{filename:'PreviewCheck.svelte',generate:'client'}).js.code,resolveDir:root}));
  b.onLoad({filter:/\.svelte$/}, async (a) => ({contents:compile(await readFile(a.path,'utf8'),{filename:a.path,generate:'client'}).js.code,resolveDir:dirname(a.path)}));
 }}]
});
const server = createServer((_req,res) => {
 res.setHeader('Content-Type','text/html');
 res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script>' + bundle.outputFiles[0].text.replaceAll('</script','<\\/script') + '</script></body></html>');
});
await new Promise((r) => server.listen(0,'127.0.0.1',r));
let browser;
let assertions = 0;
const assert = (ok,message) => { if (!ok) throw new Error(message); assertions++; console.log('ok  ' + message); };
try {
 browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined});
 const errors = [];
 const createPage = async (viewport,touch) => {
  const context = await browser.newContext({viewport,hasTouch:touch,isMobile:touch});
  const page = await context.newPage();
  page.on('pageerror',(e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  return page;
 };
 const open = async (page,id,touch) => {
  if (touch) {
   await page.locator('#' + id).tap();
   await page.locator('#' + id).dispatchEvent('pointerleave',{pointerType:'touch',pointerId:1,isPrimary:true});
  } else await page.locator('#' + id).hover();
  await page.locator('body > div > img[alt$="preview"]').waitFor({state:'visible'});
 };
 const geometry = (page,alt) => page.locator(`body > div > img[alt="${alt}"]`).evaluate((img) => {
  const r = img.parentElement.getBoundingClientRect(), v = visualViewport;
  return {x:r.x,y:r.y,w:r.width,h:r.height,vx:v?.offsetLeft ?? 0,vy:v?.offsetTop ?? 0,vw:v?.width ?? innerWidth,vh:v?.height ?? innerHeight,fit:getComputedStyle(img).objectFit};
 });
 const check = async (page,alt,ratio,centered,label) => {
  const g = await geometry(page,alt);
  assert(g.w > 0 && g.h > 0 && g.x >= g.vx - 1 && g.y >= g.vy - 1 && g.x + g.w <= g.vx + g.vw + 1 && g.y + g.h <= g.vy + g.vh + 1,label + ' stays within visible viewport');
  assert(Math.abs(g.w / g.h - ratio) < .01,label + ' preserves aspect ratio');
  if (centered) assert(Math.abs(g.x + g.w / 2 - g.vx - g.vw / 2) <= 1 && Math.abs(g.y + g.h / 2 - g.vy - g.vh / 2) <= 1,label + ' is centered');
 };
 for (const viewport of [{width:390,height:844},{width:360,height:640}]) {
  const page = await createPage(viewport,true);
  const label = `${viewport.width}x${viewport.height}`;
  await page.locator('#portrait').dispatchEvent('pointerdown',{pointerType:'touch',pointerId:9,isPrimary:true});
  assert(await page.locator('body > div > img[alt$="preview"]').count() === 0,label + ' touch down alone does not open a preview');
  await page.locator('#portrait').dispatchEvent('pointercancel',{pointerType:'touch',pointerId:9,isPrimary:true});
  await page.locator('#portrait').dispatchEvent('pointerleave',{pointerType:'touch',pointerId:9,isPrimary:true});
  assert(await page.locator('body > div > img[alt$="preview"]').count() === 0,label + ' cancelled scroll gesture leaves preview closed');
  await open(page,'portrait',true);
  await page.waitForTimeout(150);
  assert(await page.locator('body > div > img[alt="Portrait preview"]').isVisible(),label + ' touch preview remains after finger release');
  await check(page,'Portrait preview',244/340,true,label + ' portrait');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:2});
  await page.waitForTimeout(150);
  await check(page,'Portrait preview',244/340,true,label + ' zoomed visual viewport');
  await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:1});
  await cdp.detach();
  await page.setViewportSize({width:viewport.height,height:viewport.width});
  await page.waitForTimeout(150);
  await check(page,'Portrait preview',244/340,true,label + ' rotated portrait');
  await page.setViewportSize(viewport);
  // A pinned modal intentionally blocks real taps on other thumbnails. Dispatch
  // a competing activation directly to exercise shared-portal ownership teardown.
  await page.locator('#footer').dispatchEvent('pointerdown',{pointerType:'touch',pointerId:2,isPrimary:true});
  await page.locator('#footer').dispatchEvent('click');
  await page.locator('body > div > img[alt="Footer preview"]').waitFor({state:'visible'});
  await check(page,'Footer preview',3,true,label + ' footer');
  assert(await page.locator('body > div > img[alt="Portrait preview"]').count() === 0,label + ' opening another preview replaces the previous content');
  assert((await geometry(page,'Footer preview')).fit === 'contain',label + ' footer uses contain');
  await page.getByRole('button',{name:'Close preview'}).click();
  assert(await page.locator('body > div > img[alt$="preview"]').count() === 0,label + ' close button dismisses preview');
  assert(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Preview Footer preview'),label + ' touch dismissal restores thumbnail focus');
  await open(page,'portrait',true);
  await page.evaluate(() => window.unmountPreviewApp());
  assert(await page.locator('body > div > img[alt$="preview"]').count() === 0,label + ' component unmount removes pinned preview');
  await page.context().close();
 }
 const desktop = await createPage({width:1280,height:800},false);
 await open(desktop,'edge',false);
 await check(desktop,'Edge preview',244/340,false,'desktop bottom-right');
 const edge = await geometry(desktop,'Edge preview');
 assert(edge.x + edge.w < 1260,'desktop edge preview opens to the left of the pointer');
 await desktop.mouse.move(600,400);
 await open(desktop,'portrait',false);
 await check(desktop,'Portrait preview',244/340,false,'desktop top-left');
 await desktop.setViewportSize({width:450,height:500});
 await desktop.waitForTimeout(150);
 await check(desktop,'Portrait preview',244/340,false,'desktop resized');
 await desktop.mouse.move(420,450);
 const trigger = desktop.getByRole('button',{name:'Preview Portrait preview',exact:true});
 await trigger.focus(); await desktop.keyboard.press('Enter');
 await desktop.getByRole('button',{name:'Close preview'}).waitFor({state:'visible'});
 assert(await desktop.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Close preview'),'keyboard opening focuses the close button');
 await desktop.keyboard.press('Tab');
 assert(await desktop.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Close preview'),'Tab stays in the pinned preview');
 await desktop.keyboard.press('Escape');
 assert(await desktop.locator('body > div > img[alt$="preview"]').count() === 0,'Escape dismisses pinned preview');
 assert(await desktop.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Preview Portrait preview'),'keyboard dismissal restores trigger focus');
 assert(errors.length === 0,'no browser errors: ' + errors.join('; '));
 console.log(`PASS: ${assertions} CardPreview browser assertions.`);
} finally {
 await browser?.close();
 await new Promise((r) => server.close(r));
}
