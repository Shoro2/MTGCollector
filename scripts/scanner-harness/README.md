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
node scripts/scanner-harness/seed-test-db.mjs --distractors # only on an empty DB: inserts the printings from seed-cards.json (+ distractor printings, see below)
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

Columns: state before the scanner work, after spread-aware detection and
adaptive crop windows, and after the OCR input-size fix plus the plausibility
check for number-only hits (current code).

| Photo | Layout | Before | Detection + windows | OCR scale + plausibility |
|-------|--------|--------|---------------------|--------------------------|
| 2x2 upright (phone) | 4 cards | 4/4 | 4/4 | 4/4 |
| 3x5 sideways, touching cards (phone) | 15 | 4 of 12 detected | 8/15 | 11/15 |
| 2x5 sideways, touching (phone, EXIF-rotated) | 10 | 0 of 6 detected | 8/10 | 8/10 |
| 3x5 sideways (phone, EXIF-rotated) | 15 | 2/15 | 10/15 | 12/15 |
| 3x5 foils under glare (camera) | 15 | 10/15 | 11/15 | 14/15 |
| 5x3 sideways, other direction (camera) | 15 | 10/15 | 12/15 | 12/15 |
| 3x5 upright (camera) | 15 | 12/15 incl. one wrong card | 11/15 | 12/15 |
| 3x5 upright MID/VOW (camera) | 15 | 12/15 | 12/15 | 14/15 |
| **Total** | 104 | 44/104, 1 wrong | 76/104, 2 wrong* | **87/104, none wrong**, 64 s for all eight |

\* measured against the distractor database (see below); without it those two
digit misreads were "not found" because the test DB had no card at the misread
number.

**Wrong identifications.** In production a real card sits at almost every
collector number, so a single misread digit ("23/277" read as "24/277") yields
a wrong card. `seed-test-db.mjs --distractors` inserts synthetic
"Distractor SET #n" printings at every number an OCR misread of a seeded
number could produce (neighbours, glyph confusions such as 3<->8 and 1<->7, a
dropped digit) with booster-like rarities; with them in place the harness
reports such hits as WRONG. The plausibility rules in the scan page
(`numberOnlyHitPlausible`) were tuned against this database.

**OCR input size.** `ocr-scale-experiment.mjs` runs a scan, then re-OCRs every
name and collector crop at several scales and page-segmentation modes and
counts hits against the expectations. It is the evidence behind
`NAME_OCR_SCALE` / `BOTTOM_OCR_SCALE` in `src/routes/scan/+page.svelte`: on 75
cards, 41 names were read at the old 6x crops, 51 at 1.5x and 58 with a
second raw-line (PSM 13) pass at 2x; collector strips 18 at 6x, 24 at 4x, 27
with a second pass at 2x.

```bash
node scripts/scanner-harness/ocr-scale-experiment.mjs --json out.json photos/*.jpg
```

The remaining 17 misses are showcase/borderless frames (no name bar or
collector line where the crops expect them), collector digits misread at
~12 px (15 cards on one phone photo is the resolution limit for Tesseract),
names truncated by the OCR ("Skaab"), and dropped digits that are now
rejected instead of misidentified ("4/277" for Unruly Mob 040/277, "80/277"
for Dawnhart Rejuvenator 180/277).

Notes: the fake camera crops portrait clips when the app asks for 1920x1080,
so render live scenes in landscape; real phones deliver native portrait frames.
