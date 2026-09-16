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
`expectations-real-photos.json` lists the eight real phone/camera spreads used
during development (the photos themselves are not in the repository); their
printings are part of `seed-cards.json`.

```bash
# Diagnostics: detection overlay + every card's warp / name crop / bottom crop as one PNG montage
node scripts/scanner-harness/dump-debug.mjs photos/spread.jpg out/ multiple
```

## Reference results (September 2026, seeded DB, self-hosted libraries)

| Photo | Layout | Before | After |
|-------|--------|--------|-------|
| 2x2 upright (phone) | 4 cards | 4/4 | 4/4 |
| 3x5 sideways, touching cards (phone) | 15 | 4 of 12 detected | 8/15 |
| 2x5 sideways, touching (phone, EXIF-rotated) | 10 | 0 of 6 detected | 8/10 |
| 3x5 sideways (phone, EXIF-rotated) | 15 | 2/15 | 10/15 |
| 3x5 foils under glare (camera) | 15 | 10/15 | 11/15 |
| 5x3 sideways, other direction (camera) | 15 | 10/15 | 12/15 |
| 3x5 upright (camera) | 15 | 12/15 incl. one wrong card | 11/15, none wrong |
| 3x5 upright MID/VOW (camera) | 15 | 12/15 | 12/15 |

Remaining misses are mostly showcase/borderless frames (no readable name bar
or collector line in the expected places), cards whose grid cell is offset by
a neighbour's shadow, and names truncated by the OCR ("Skaab", "Ghoulish").

Notes: the fake camera crops portrait clips when the app asks for 1920x1080,
so render live scenes in landscape; real phones deliver native portrait frames.
