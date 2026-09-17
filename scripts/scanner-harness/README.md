# Scanner harness

Runs the real `/scan` pipeline (OpenCV.js detection, Tesseract.js OCR, name and
collector-number matching) headlessly against image files and reports what was
identified. Works fully offline once the browser libraries are self-hosted.

## One-time setup

```bash
npm install                                   # playwright is a devDependency
npx playwright install chromium               # browser binary; or point PLAYWRIGHT_CHROMIUM_PATH at an existing Chromium
node scripts/scanner-harness/vendor-assets.mjs   # optional offline mode: OpenCV.js + Tesseract.js + eng data + onnxruntime-web + PaddleOCR model -> static/vendor/ (gitignored)
echo 'PUBLIC_SCANNER_ASSETS_URL=/vendor' >> .env  # only with the vendored assets; otherwise the CDN copies are used
```

The harness needs a dev server per database. **Two databases matter**: the
full Scryfall catalogue (`npm run import-cards`, ~115k printings — what
production sees) and the small *seeded* catalogue with distractor printings
(the regression baseline). Run them side by side from one checkout — the DB
path and the background jobs are configurable, so no worktree is needed:

```bash
# Full catalogue on :5173. DISABLE_PRICE_UPDATES=1 keeps the catalogue frozen
# during a measurement (the boot-time catch-up otherwise updates prices and
# inserts new cards).
DISABLE_PRICE_UPDATES=1 npm run dev

# Seeded catalogue on :5174, in its own file. Without DISABLE_PRICE_UPDATES the
# catch-up job would import every Scryfall card into the empty seed database.
MTG_DB_PATH=/tmp/seed-db/mtg.db DISABLE_PRICE_UPDATES=1 npx vite dev --port 5174 --strictPort
curl -s -H 'Accept: text/html' -o /dev/null http://localhost:5174/scan   # first request creates the schema
MTG_DB_PATH=/tmp/seed-db/mtg.db node scripts/scanner-harness/seed-test-db.mjs --distractors
```

> **Never run `seed-test-db.mjs` against the full database**: it writes with
> `INSERT OR REPLACE` into whatever `MTG_DB_PATH` (default `data/mtg.db`)
> points at and would plant ~770 synthetic "Distractor" printings in the real
> catalogue.

`HARNESS_URL` (default `http://localhost:5173`) tells every script below which
server to drive. Vite binds `localhost`, which may resolve to `::1` only;
Chromium tries both address families, so keep the host name rather than
`127.0.0.1`.

## Running

```bash
# Upload path: single or multiple mode, one result block per file
# Seeded catalogue (:5174) against the committed seed baseline:
HARNESS_URL=http://localhost:5174 node scripts/scanner-harness/harness.mjs --mode multiple --expect scripts/scanner-harness/expectations-real-photos.json --baseline scripts/scanner-harness/baseline.json photos/*.jpg
# Full catalogue (:5173) against its own baseline (the primary number: wrong identities/printings in production conditions):
node scripts/scanner-harness/harness.mjs --mode multiple --expect scripts/scanner-harness/expectations-real-photos.json --baseline scripts/scanner-harness/baseline-fulldb.json --out results-fulldb.json photos/*.jpg
node scripts/scanner-harness/harness.mjs --mode single --expect scripts/scanner-harness/expectations.json fixtures/synth-single.jpg
# Re-score a saved --out file against (corrected) expectations without scanning again:
node scripts/scanner-harness/rescore.mjs results-fulldb.json scripts/scanner-harness/expectations-real-photos.json

# Synthetic fixtures (no photos needed)
node scripts/scanner-harness/make-synthetic.mjs fixtures/

# Live mode: a Y4M clip is played as the camera (Chromium fake device)
node scripts/scanner-harness/make-live-y4m.mjs fixtures/live-scene.y4m
node scripts/scanner-harness/live-harness.mjs fixtures/live-scene.y4m live-result.png
# Live UX: capture / result cues, pause (camera released, results stay), resume without a second capture
node scripts/scanner-harness/live-ux-check.mjs fixtures/live-scene.y4m
```

`--expect` takes a JSON map from file name to the card instances in the photo,
each either a printing `{ "name", "set", "number" }` or a plain name (identity
only). The harness then scores every photo at two levels — *identity* (the
accepted name matches an expected instance) and *printing* (its unique set +
number is the expected one) — and reports unresolved printings, wrong
identities, wrong printings, missing and extra cards, and cards offered as
`likely` (one-tap confirmation) or `conflict` (both readings shown), neither
counted as identified nor as wrong. `--out results.json` stores every card's
OCR text, chosen printing, state and the full debug log for later analysis.
`expectations-real-photos.json` lists the eight real phone/camera spreads used
during development (the photos themselves are not in the repository;
`photo-inventory.json` records their SHA-256, sizes and instance counts);
their printings are part of `seed-cards.json`.

**Ground truth is verified against the catalogue.** Every expected printing
must exist in the database under that name, set and number. Round 10 found
eleven of the 104 instances wrong in the hand-written list (Tenderize TMT
#133, not #123; The Last Ronin's Technique #223, not #323; Lantern Flare VOW
#23, not MID; Renet #202, Casey Jones #207, Michelangelo #118, Persistent
Specimen VOW #125, Daybreak Combatants VOW #153, Rotten Reunion MID #119,
Hinterland Harbor TMC #69, Primordial Pachyderm #129, and TMT #70 is spelled
"Paramecia Coloniex" on Scryfall) — the seeded catalogue had been typed from
the same list, so those errors were invisible until the full database was
used. Check with:

```bash
node -e "const D=require('better-sqlite3');const db=new D('data/mtg.db',{readonly:true});const e=require('./scripts/scanner-harness/expectations-real-photos.json');const q=db.prepare(\"SELECT name FROM cards WHERE set_code=? AND collector_number=? AND layout<>'art_series'\");for(const rows of Object.values(e))for(const r of rows){const row=q.get(r.set,r.number);if(!row||row.name!==r.name)console.log('MISMATCH',r.name,r.set,r.number,'->',row?row.name:'none')}"
```

`--write-baseline baseline.json` stores the per-photo metrics;
`--baseline baseline.json` compares a later run against them and exits 1 when
identity or printing drops or wrong identities/printings rise for any photo.
`baseline.json` in this directory is the committed reference for the eight
photos.

`export-seed.mjs` regenerates `seed-cards.json` from a fully imported
database (real Scryfall ids, canonical "Front // Back" names, `card_faces`,
layouts, rarities) for the printings listed in the real-photo and the
synthetic expectations (`--out` and explicit expectation files are optional).
Run it after every change to an expectations file; the synthetic fixtures
print real M10/MH2/RVR collector numbers so they resolve to real printings.
Double-faced cards must carry the canonical name and their faces: the scanner
reads the face name, the database stores the canonical one.

```bash
# Diagnostics: detection overlay + every card's warp / name crop / bottom crop as one PNG montage
node scripts/scanner-harness/dump-debug.mjs photos/spread.jpg out/ multiple
```

## Hold-out set (WP0.4)

Six phone photos taken on 2026-09-16 after the development set was frozen
(`photo-inventory-holdout.json`: hashes, motifs; `expectations-holdout.json`:
26 card instances, every entry verified to exist in the catalogue). They are
**never used for tuning**; a change is measured on them after the fact, and
they are reported separately from the eight development photos. Spreads run in
multiple mode, the two single-card photos in single mode
(`baseline-holdout.json` carries the mode per photo):

```bash
E=scripts/scanner-harness/expectations-holdout.json
node scripts/scanner-harness/harness.mjs --mode multiple --expect $E holdout/20260916_202337.jpg holdout/20260916_202915.jpg holdout/20260916_203317.jpg holdout/20260916_203408.jpg
node scripts/scanner-harness/harness.mjs --mode single   --expect $E holdout/20260916_202956.jpg holdout/20260916_203427.jpg
```

Six expected printings were read from the photos and still await the owner's
confirmation: Thassa's Oracle SLD #1280 (retro frame), the full-art foil
Mountain SOS #270, Counterspell FCA #4 (the card shows the flavor name "Wild
Rose Rebellion"), Misdirection DDT #15, Force of Will ALL #28 ("Illus. Terese
Nielsen", old frame) and Tropical Island 30A #279. Identity does not depend
on them; the printing metric does.

**Result against the full catalogue (2026-09-16, same code as the Round 10
column above):** identity **16 / 26**, printing **5 / 26**, 11 printings
open, 4 `likely`, **0 wrong**, 10 missing; the negative photo (sleeved backs,
a deck box) yields two unidentified rectangles and no identification, as it
should. **With Phase 3 (full art-hash table, 2026-09-17):** identity
**18 / 26**, printing 6 / 26, 12 open, 3 `likely`, **0 wrong** — the two
flavor-name cards (Koma, Counterspell) are recognised by their artwork; most
of the open printings are much-reprinted cards whose footer the strip crop
misses (see the classes below). Failure classes the development set did not contain — none of them
tuned away, all logged for the roadmap:

- **Flavor names** (Universes Beyond): the card prints "The Monstrous
  Serpent" (Koma, Cosmos Serpent, TLE) or "Wild Rose Rebellion" (Counterspell,
  FCA); the catalogue has no `flavor_name` column, so the name channel cannot
  match them and one became a `likely` of the wrong card. Needs the Scryfall
  `flavor_name` field at import and as a name alias.
- **Collector number on its own line** (SOA, TLE showcase frames): the strip
  crop catches "SOA • EN ILLUS …" but the number sits on the line above; only
  the name identifies these cards and the printing stays open.
- **A black-bordered card filling the frame on a dark cloth** (single-card
  photo; **fixed 2026-09-17** by the coarse fallback, Strategy 7 — the card is
  now identified with its printing, hold-out identity 19 / 26, printing 7 / 26): all six strategies return the image frame itself as the card, the
  warp is the whole photo and the name window lands on the rules text — in
  single *and* multiple mode. The live scanner's edge guard would refuse such a
  frame; the upload path needs a "card = whole image" fallback.
- **Old frames** (Alliances Force of Will, a numberless Tropical Island): the
  name font defeats every pass and there is no collector line.
- **Foil glare on a full-art land** and one upside-down warp (Misdirection)
  that the rotated retry did not recover.

The 11 open printings are the same class as on the development set (many
printings, footer unreadable): basic lands, Preordain, Flooded Strand, LTR /
DSK / WAR cards with several variants.

## Reference results (September 2026)

Columns: state before the scanner work, after spread-aware detection and
adaptive crop windows, after the OCR input-size fix plus the plausibility
check for number-only hits, the fusion phases (all against the seeded DB with
distractors) — and finally **Round 10, the same photos against the full
Scryfall catalogue** (115,459 printings, 38k distinct names, tokens and
The List / Double Feature reprints included), which is what production sees.

| Photo | Layout | Before | Detection + windows | OCR scale + plausibility | Evidence fusion (identity / printing) | Phase 2 passes + PaddleOCR | Phase 4 grid hypothesis | Round 10, seeded DB | **Round 10, full DB** (identity / printing) | **Phase 3, full DB + art-hash table** (identity / printing) |
|-------|--------|--------|---------------------|--------------------------|----------------------------------------|----------------------------|-------------------------|---------------------|---------------------------------------------|---|
| 2x2 upright (phone) | 4 cards | 4/4 | 4/4 | 4/4 | 4 / 4 | 4 / 4 | 4 / 4 | 4 / 4 | 4 / 4 | 4 / 4 |
| 3x5 sideways, touching cards (phone) | 15 | 4 of 12 detected | 8/15 | 11/15 | 12 / 12 | 14 / 14 | 15 / 15 | 15 / 15 | 14 / 11, 3 printings open, 1 likely | 15 / 13, 2 open |
| 2x5 sideways, touching (phone, EXIF-rotated) | 10 | 0 of 6 detected | 8/10 | 8/10 | 8 / 8 | 9 / 9 | 10 / 10 | 10 / 10 | 10 / 10 | 10 / 10 |
| 3x5 sideways (phone, EXIF-rotated) | 15 | 2/15 | 10/15 | 12/15 | 12 / 12 | 15 / 15 | 15 / 15 | 15 / 15 | 14 / 12, 2 open, 1 likely | 14 / 13, 1 open, 1 likely |
| 3x5 foils under glare (camera) | 15 | 10/15 | 11/15 | 14/15 | 14 / 14 | 15 / 15 | 15 / 15 | 15 / 15 | 15 / 12, 3 open | 15 / 15 |
| 5x3 sideways, other direction (camera) | 15 | 10/15 | 12/15 | 12/15 | 13 / 13 | 15 / 15 | 15 / 15 | 15 / 15 | 13 / 8, 5 open, 2 likely | 15 / 12, 3 open |
| 3x5 upright (camera) | 15 | 12/15 incl. one wrong card | 11/15 | 12/15 | 13 / 13 + 2 likely | 14 / 14 + 1 likely | 14 / 14 + 1 likely | 14 / 14 + 1 likely | 13 / 7, 6 open, 2 likely | 15 / 10, 5 open |
| 3x5 upright MID/VOW (camera) | 15 | 12/15 | 12/15 | 14/15 | 14 / 14 | 15 / 15 | 15 / 15 | 15 / 15 | 12 / 6, 6 open, 3 likely | 15 / 6, 9 open |
| **Total** | 104 | 44/104, 1 wrong | 76/104, 2 wrong* | 87/104 names, none wrong, 64 s | 90 / 90 of 104, 2 likely, none wrong, 65 s | **101 / 101 of 104, 1 likely, none wrong**, 79 s | **103 / 103 of 104, 1 likely, none wrong**, 76.9 s | **103 / 103 of 104, 1 likely, none wrong**, 33 s | **95 / 70 of 104, 25 printings open, 9 likely, none wrong**, 89 s | **103 / 83 of 104, 20 printings open, 1 likely, none wrong**, 78 s |

The fusion columns are measured with the canonical seed (double-faced names)
and the printing-level metric; the earlier columns counted names only. The
Phase 4 column differs from Phase 2 only in the detection stage (oriented
dimension filter and the grid hypothesis of `src/lib/scanner/grid.ts`). The
"87 names" run drops to 86 under those conditions (Beloved Beggar's front face
no longer matched its canonical name), which the face-aware search fixed.
Wall times up to Phase 4 are from the sandbox, the Round 10 ones from a
desktop PC (the seeded run there takes 33 s), so only the identity columns
compare across the two.

**Round 10 — the full catalogue (2026-09-16).** Before Round 10 the same code
scored **78 / 55 of 104 with 23 wrong identities** against the full database
(after correcting the ground truth; 27 wrong and 6 wrong printings before,
see above). Every wrong identity came from the name channel meeting a pool
of 38k names instead of 70: eleven were Scryfall *art-series* records
("Zog, Triceraton Castaway // Zog, Triceraton Castaway"), four were an
uncertain name (0.60–0.75) overriding a strong collector-line reading of
another card ("pean Zia Cavalry" → Llanowar Cavalry while the strip said
`C 0156 TMT EN`, Mechanized Ninja Cavalry), four were two- or three-letter
fragments matching short names or faces ("Boa" → the token Boar, "Cal" →
Beck // Call, "fasten" → Fast // Furious), two were the right name missing
from a truncated candidate list ("Escave Tunnel" → Ice Tunnel while Escape
Tunnel sat beyond the 20-row cut), and the rest were junk texts or close
siblings ("Easy Te" → Easy Prey, Dawnhart Geist for Dawnhart Rejuvenator).
The fixes (`src/lib/scanner/full-pool.test.ts` pins every class): art-series
records are excluded from every scanner query; fuzzy candidates are ranked
server-side by the scanner's own similarity before the cut; a name alone
identifies a card only with enough substance (`nameIdentifies()`: score ≥
0.6, an exact read for names or faces under six characters, a real word in
the text below 0.8); below 0.8 the footer gets a say (an exact structural
reading that names a card fitting the text beats the name, a real set code
the name was never printed in demotes it to `likely`), and a runner-up
within 0.1 on the whole text makes the identity a one-tap choice; the best
few names of every pass are recorded as evidence. Result: **0 wrong**, 95
identities, 9 one-tap offers. The 25 open printings are genuine catalogue
ambiguity with an unreadable footer: same-set variants (TMT #126 / #240),
Innistrad: Double Feature reprints with the *same* collector numbers as MID /
VOW, The List, promos, and Forest with 200 printings; the seeded DB had made
them unique by construction. Two intermittent 15-minute hangs traced to a
stalled CDN download got the PaddleOCR and Tesseract loads a 90 s deadline.

**Phase 3 — the artwork as evidence (2026-09-16).** Every warped card is
hashed like the reference images (`src/lib/scanner/phash.ts`) and the server
returns the printings within 12 bits from its in-memory index (WP3.1 job,
`npm run hash-art`; measured here with the hashes of 20 sets, 8.5k printings,
while the full run continued). Two things had to be measured first, with
`art-box-experiment.mjs` on the 102 warps of the eight photos: the warp keeps
~3.5 % of background around the detected quad, so the reference box as-is
hashed the same artwork 12.3 bits away on average (51 cards within 10 bits);
moved 2 % inwards it is 9.2 bits (78 within 10). And against the reference
hashes of *every* printing of a name (`--printings`), same-artwork reprints
and variants (MID vs Double Feature, regular vs extended frame) sit 0–8 bits
behind the nearest printing while different artwork sits 20–36 behind — so the
artwork narrows a printing list only with a 16-bit gap and never settles a
printing on its own (a first version that confirmed the single printing inside
the search radius turned Lantern Flare VOW #23 into the extended-art #351).
The nearest artwork at 12–14 bits was a different card in 7 of 15 cases, so
the artwork alone (without an agreeing name) never produces a one-tap offer
and the radius is 12. Result on the eight photos: identity 95 → **103**,
printing 70 → **79** of 104, 1 `likely`, **0 wrong**; the seeded DB with the
same hashes imported (`npm run hash-art -- --export/--import`) 104 / 104.
Re-measured against the **full table** on 2026-09-17 (112 772 printings +
1 594 back faces; the column above): **103 / 83**, 20 printings open, 0 wrong
— more printings hashed means more different-artwork variants drop out of the
candidate lists. Over both photo sets every nearest artwork at ≤ 10 bits was
the right card (91 of 91 against 114k hashes); at 12 bits only 10 of 16 were,
which is why a 12-bit match counts only together with an agreeing name.
The one miss is a small, sideways Dawnhart Rejuvenator whose hash lands more
than 12 bits from every reference (it stays a `likely` of Dawnhart Geist from
the name channel).

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

The remaining one after Phase 4: The Last Ronin's Technique on one camera
photo (showcase frame; offered as `likely` from "LAST … Techmaue" + "223 THT"
— and #223 *is* the printed number; the seed said #323 until Round 10
verified the ground truth against the catalogue). Retro-Mutation and Tunnel
Rats were recovered by the grid hypothesis: the lattice-derived cells warp
those cards a little differently and their name bars became legible to the
existing passes.

**Name-band experiments.** `ocr-preprocess-experiment.mjs` re-OCRs every name
crop with canvas-only preprocessings (Otsu binarisation, inversion, contrast
stretch, blur) at two scales and reports the union with the two gray passes;
`ocr-engine-experiment.mjs` reads the same crops with PaddleOCR's PP-OCRv4
recognition model (ONNX, onnxruntime-web, needs `static/vendor/ort/` and
`static/vendor/paddle/` from `vendor-assets.mjs`). On 75 cards: gray PSM 7
49, binarised 57, union of the Tesseract passes 68, PaddleOCR alone 64, both
engines 72. The scan page runs the passes in that order and PaddleOCR last.

Notes: the fake camera crops portrait clips when the app asks for 1920x1080,
so render live scenes in landscape; real phones deliver native portrait frames.
The live harness's `[live]` lines show which detector ran (`detector: Web
Worker (OpenCV.js off the main thread)` — the worker is bundled to
`static/scanner/detect-worker.js` by `npm run build:worker`, which `npm run
dev` runs automatically) and the best-frame line (`Best frame of the scene:
sharpness …, glare …, … ms old`). The LiveScanner root carries
`data-detector="worker|main"` and the badge `data-quality-hint="blurry|glare|"`
for assertions.

## The live detector, offline (2026-09-17)

A phone session on a dark woven play mat (scan logs on the host, screenshots)
showed long waits, the art box or the text box captured as the card,
four-cornered patches of the mat captured, and bow-tie warps from manual
captures. The live detector (`src/lib/scanner/quick-rects.ts`) can be run in
Node on still images — the very code the phone runs per frame:

```bash
# OpenCV.js is not in the repository; any copy of the 4.9 build works
npm i --prefix /tmp/cvnode @techstark/opencv-js@4.9.0-release.3
export OPENCV_JS=/tmp/cvnode/node_modules/@techstark/opencv-js/dist/opencv.js

# what does the detector see in these photos? (overlay PNGs in out/)
npx tsx scripts/scanner-harness/live-detect-experiment.mjs --out out photo1.jpg photo2.jpg

# labelled frames: real card images on the mat texture of a photo, plain light and plain black
node scripts/scanner-harness/make-mat-scenes.mjs --out scenes --mat holdout/20260916_203427.jpg
npx tsx scripts/scanner-harness/live-detect-experiment.mjs --out out --truth scenes/scenes.json [--old old-quick-rects.ts]

# end to end: a still as the camera
node scripts/scanner-harness/make-still-y4m.mjs scenes/mat-039.jpg mat-039.y4m
node scripts/scanner-harness/live-harness.mjs mat-039.y4m mat-039.png
```

The root cause was not low contrast as such: the weave of the mat gives the
fine Canny edge map a mesh that fuses with the card outline, so no
four-cornered external contour is left for the card, while the art box, the
text box and random cells of the mesh are clean rectangles of card-like
proportions (the art box is 0.73, a card 0.716). At half the resolution with a
9x9 blur the weave averages out and the step between the black border and the
mat survives. Result on 102 labelled frames (38 cards, every colour, ten black
ones; rotated +-7 degrees or sideways, 75-100% brightness, slight blur), found
= box IoU >= 0.72 (on a dark background the quad sits on the card's inner
frame, 5% inside the outline, which the pipeline's 5% expansion absorbs):

| Background | Frames | Found before | Found now | False positives before / now |
|---|---|---|---|---|
| woven dark mat | 76 | 44 | **72** | 20 / 3 |
| plain black | 13 | 8 | **13** | 4 / 0 |
| light table | 13 | 13 | 13 | 0 / 0 |

Detection time per frame rose from 11 to 15 ms on a desktop. The real photos
are unchanged where the detector worked (the five spreads it read completely,
15 of 15 each) and
better where it did not (hold-out spreads 3 -> 6 of 6, 5 -> 6 of 6, 5 -> 6 of
12; the negative photo 1 -> 0 rectangles; the black card on the dark cloth: a
patch of the mat -> the card). Still missed: two frames of a dark land, two
other dark cards; an inner block of a black card is still tracked when no pass
sees the outline. End to end (`live-harness.mjs`): the black card on the real
mat photo and a dimmed black card scene are captured within a second and
identified; the classic two-card fixture still reads 2 / 2.
