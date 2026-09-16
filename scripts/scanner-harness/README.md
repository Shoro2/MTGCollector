# Scanner harness

Runs the real `/scan` pipeline (OpenCV.js detection, Tesseract.js OCR, name and
collector-number matching) headlessly against image files and reports what was
identified. Works fully offline once the browser libraries are self-hosted.

## One-time setup

```bash
npm install                                   # playwright is a devDependency
npx playwright install chromium               # browser binary; or point PLAYWRIGHT_CHROMIUM_PATH at an existing Chromium
node scripts/scanner-harness/vendor-assets.mjs   # OpenCV.js + Tesseract.js + eng data -> static/vendor/ (gitignored)
echo 'PUBLIC_SCANNER_ASSETS_URL=/vendor' >> .env
npm run dev                                   # in a second terminal
node scripts/scanner-harness/seed-test-db.mjs # only on an empty DB: inserts the printings from seed-cards.json
```

With a fully imported card database (`npm run import-cards`) the seed step is
unnecessary; the harness then runs against the real card pool.

## Running

```bash
# Upload path: single or multiple mode, one result block per file
node scripts/scanner-harness/harness.mjs --mode multiple photos/*.jpg
node scripts/scanner-harness/harness.mjs --mode single --expect scripts/scanner-harness/expectations.json fixtures/synth-single.jpg

# Synthetic fixtures (no photos needed)
node scripts/scanner-harness/make-synthetic.mjs fixtures/

# Live mode: a Y4M clip is played as the camera (Chromium fake device)
node scripts/scanner-harness/make-live-y4m.mjs fixtures/live-scene.y4m
node scripts/scanner-harness/live-harness.mjs fixtures/live-scene.y4m live-result.png
```

`--expect` takes a JSON map `{ "<file name>": ["Card Name", ...] }` and prints
matched / wrong / missing names per photo. `--out results.json` stores every
card's OCR text, chosen printing and the full debug log for later analysis.

Notes: the fake camera crops portrait clips when the app asks for 1920x1080,
so render live scenes in landscape; real phones deliver native portrait frames.
