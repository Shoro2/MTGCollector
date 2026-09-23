# CLAUDE.md - MTG Collector

**All project files (code, comments, commit messages, documentation) must be written in English.**

## Project Overview

MTG Collector is a full-stack web app for tracking Magic: The Gathering card collections. Built with SvelteKit, SQLite, and Tailwind CSS. Features card browsing, collection management, wishlist, price tracking with profit/loss analysis, card scanning (OCR + foil detection), and Moxfield CSV import/export.

## Quick Start

```bash
npm install                  # Install dependencies
npm run import-cards         # Download Scryfall bulk data (required first time, ~600MB)
npm run dev                  # Start dev server at http://localhost:5173
npm run build                # Production build (node adapter)
npm run build:worker         # Bundle the live-scanner detection worker (runs automatically before dev/build)
npm run hash-art             # Art-hash index for the scanner (resumable; --status, --limit N, --sets a,b, --delay ms, --retry-failed, --export/--import file)
npm run check                # TypeScript + Svelte validation
```

### Environment Variables (`.env`)

```
GOOGLE_CLIENT_ID=...         # Google OAuth credentials
GOOGLE_CLIENT_SECRET=...     # From console.cloud.google.com/apis/credentials
ORIGIN=http://localhost:5173 # App URL (used for OAuth callback)
MTG_DB_PATH=...              # Optional: SQLite file to use instead of data/mtg.db (a second instance on a seeded harness catalogue)
DISABLE_PRICE_UPDATES=1      # Optional: no scheduled/catch-up price runs — freezes the catalogue for measurements (never set in production)
```

Google OAuth redirect URI: `{ORIGIN}/auth/callback/google`

> **No cloud OCR.** The Google Vision retry (per-user API keys in `/settings`, `/api/ocr`, the on-page toggle, usage statistics) was removed on 2026-09-17 at the owner's request; the scanner runs on local OCR and the art-hash index only. `users.google_vision_api_key` and the `api_usage` table remain in the schema, unused, so existing databases and the positional INSERTs of the nightly user-data dump keep loading.

## Tech Stack

- **Framework**: SvelteKit 2 with Svelte 5 (runes enabled globally)
- **Database**: SQLite via better-sqlite3 + Drizzle ORM
- **Styling**: Tailwind CSS 4 with CSS custom properties (dark theme)
- **Auth**: Google OAuth 2.0 via `arctic` (PKCE flow)
- **Adapter**: `@sveltejs/adapter-node` for production
- **External**: Scryfall API, OpenCV.js (CDN), Tesseract.js (CDN), Chart.js, Frankfurter API (exchange rates), Plausible Analytics (self-hosted)

## Architecture

### Svelte 5 Runes

This project uses **Svelte 5 runes exclusively** — no legacy `$:` reactivity or stores.

- `$state` for reactive variables
- `$derived` for computed values
- `$effect` for side effects (portal DOM manipulation, initialization)
- `$props` with destructuring for component props
- `{@render children()}` instead of `<slot>` (Svelte 5 snippets)
- `{@const}` only inside `{#if}`, `{#each}` blocks — never as direct child of `<div>`

### Database

**File**: `data/mtg.db` (auto-created)

Two query patterns coexist:
- **Drizzle ORM** for simple queries (`src/routes/+page.server.ts`)
- **Raw SQL** via `sqlite.prepare()` for complex queries (FTS5, joins, aggregations)

**Tables**: `cards`, `card_faces`, `users`, `sessions`, `collection_cards`, `wishlist_cards`, `tags`, `collection_card_tags`, `price_history`, `api_usage` (legacy, unused)

**FTS5**: `cards_fts` virtual table for full-text search (name, type_line, oracle_text)

**Migrations**: Done via try/catch `ALTER TABLE ADD COLUMN` in `initDb()` — not via Drizzle migrations.

### Authentication

Google OAuth with session cookies:
1. `/auth/login/google` — generates state + PKCE verifier, redirects to Google
2. `/auth/callback/google` — validates, creates/updates user, sets session cookie
3. `hooks.server.ts` — validates session on every request, sets `locals.user`
4. Sessions expire after 30 days

**Public routes**: `/`, `/cards`, `/cards/[id]`, `/scan`, `/login`, `/auth/*`, `/impressum`, `/datenschutz`, `/api/health`, `/api/scan-log` (POST; its GET is admin-only)
**Protected routes**: `/collection`, `/wishlist`, `/prices`, `/tags` — redirect to `/login`
**Admin routes**: `/admin`, `/admin/api/*` — redirect non-admins to `/`. User must have `isAdmin: true` in `App.Locals`.

### Multi-User Collections

All `collection_cards` and `wishlist_cards` queries filter by `user_id`. Each user has an isolated collection and wishlist. The `user_id` column is nullable for backward compatibility with pre-auth databases.

### Price System

- **EUR primary, USD fallback**: Prices display in EUR when available, otherwise USD with `$` prefix
- **USD→EUR conversion**: For profit/loss calculations, USD prices are converted using a live exchange rate from `frankfurter.dev` (cached 6 hours, fallback 0.92). See `src/lib/server/exchange-rate.ts`
- **Price history**: At most one entry per card per calendar day (enforced by `UNIQUE(card_id, snapshot_date)` on a dedicated `snapshot_date` column, independent of server timezone). A new row is only written when at least one of the four prices differs from the card's previous snapshot, so static prices don't produce daily duplicates.
- **Price snapshots**: Include both EUR and USD prices (`price_eur`, `price_eur_foil`, `price_usd`, `price_usd_foil`)
- **Foil-only printings**: some printings exist only in foil (The Hobbit extras, many promos) and have no `price_eur`/`price_usd`. List and tile contexts (`/cards`, card detail reprints, wishlist, scan results) render prices through `PriceTag.svelte` → `displayPrice()`, which falls back to the foil price and marks it with a small "Foil" chip. The `/cards` price sort uses `COALESCE(price_eur, price_eur_foil)`. Collection rows use the owned copy's own foil flag as before.
- **Cardmarket trend anomalies**: Scryfall's `eur`/`eur_foil` is Cardmarket's *trend* price, which occasionally collapses for thinly traded printings (known case: Smaug the Magnificent, HOB #249 foil — trend €300 while the cheapest offer is ~€25k and the 30-day average ~€10k; the USD side stayed sane). The app never alters the value; `priceDivergence()` compares EUR with USD×rate and the card detail page shows a "Check this price" note when they differ by more than 5× (`PRICE_DIVERGENCE_LIMIT`). Collection/prices totals still use the EUR value as delivered — see Roadmap.

### Price Updates

Background job checks Scryfall `bulk-data` API for new data, downloads only when newer data exists. Runs 5s after server start (deferred to avoid SSR fetch warning). Snapshots prices for **all cards that have at least one Scryfall price** (so the history is available for every card, not just collection cards). The snapshot INSERT is change-aware: it compares the new price with the card's latest `price_history` row and skips cards whose four prices are identical. Manual trigger: `npm run import-cards` or POST to `/api/prices` (admin only).

## Directory Structure

```
src/
├── app.css                          # Dark theme, Tailwind imports
├── app.d.ts                         # App.Locals type (user, isAdmin)
├── hooks.server.ts                  # Auth middleware, DB init, price check, admin guard
├── lib/
│   ├── components/
│   │   ├── CardPreview.svelte       # Hover zoom (portal to document.body)
│   │   ├── LiveScanner.svelte       # Camera viewfinder for /scan live mode (overlay, stability, best-frame capture, blur/glare hints, capture cues, pause/review mode)
│   │   └── PriceTag.svelte          # List price with foil-only fallback + "Foil" chip (displayPrice)
│   ├── scanner/                     # Browser-side scanner library; pure modules are unit-tested (vitest)
│   │   ├── detect.ts                # createQuickDetector(): live detector — Web Worker with its own OpenCV copy, main-thread fallback
│   │   ├── quick-rects.ts           # Live rectangle scan on an RGBA buffer: fine + coarse Canny pass, card-quad and content checks, containment rules; frame quality (shared by main thread and worker)
│   │   ├── quad.ts                  # Card-quad sanity (convex, angles, side ratios, rotation-invariant aspect) and luminance sampling inside a quad (pure)
│   │   ├── detect-worker.ts         # Detection Web Worker; bundled by scripts/build-detect-worker.mjs to static/scanner/ (gitignored)
│   │   ├── quality.ts               # Laplacian sharpness, glare fraction, BestFrameSelector (live best-frame capture)
│   │   ├── grid.ts                  # Spread geometry: oriented dimension filter, lattice indexing, affine/homography grid hypothesis
│   │   ├── stability.ts             # SceneStabilizer + sceneSignature(): time-based "scene holds still" logic
│   │   ├── geometry.ts              # orderCornersForCard(), fitContain(), touchesFrameEdge(), loadImage()
│   │   ├── opencv.ts                # Lazy OpenCV.js CDN loader
│   │   ├── tesseract.ts             # Tesseract.js worker pool (recognizeBatch, recognizeDetailed)
│   │   ├── parse.ts                 # parseCollectorInfo(): set code / collector number / foil hint
│   │   ├── similarity.ts            # Name similarity, OCR-junk heuristic, prefix-aware bestNameMatch()
│   │   ├── foil.ts                  # Pixel-based foil detection from the separator glyph
│   │   ├── pipeline.ts              # disambiguateReprints(), normalizeCollectorNumber()
│   │   ├── paddle.ts                # PaddleOCR PP-OCRv4 recognition via onnxruntime-web (lazy, second name engine)
│   │   ├── ctc.ts                   # ctcDecode(): greedy CTC decoding of the recognition output (pure)
│   │   ├── timeout.ts               # withTimeout(): deadline for the lazily loaded OCR engines (a stalled CDN must not hang a scan)
│   │   ├── feedback.ts              # Live-scan cues: WebAudio tones + navigator.vibrate patterns (capture / identified / unresolved), preferences in localStorage
│   │   ├── phash.ts                 # 64-bit DCT perceptual hash of the art box, Hamming distance, gray/resize helpers (shared by server job and scanner)
│   │   ├── art-search.ts            # searchHashes(): Hamming search over hash entries (pure part of the server's art index)
│   │   └── resolve.ts               # resolveCard(): evidence fusion -> identity / printing / finish decisions with states; nameIdentifies()
│   ├── server/
│   │   ├── auth.ts                  # OAuth, sessions, user CRUD
│   │   ├── db.ts                    # SQLite setup, initDb(), migrations
│   │   ├── exchange-rate.ts         # USD→EUR rate (frankfurter.dev, 6h cache)
│   │   ├── images.ts                # Card image downloader
│   │   ├── price-updater.ts         # Scryfall bulk price updates
│   │   ├── art-hash.ts              # Art-hash job: walks the catalogue, stores hashes into cards.art_hash / card_faces.art_hash, export/import
│   │   ├── art-image.ts             # Fetch a Scryfall image and hash its art box (sharp; DB-free, unit-tested)
│   │   ├── art-index.ts             # In-memory art-hash index for the scanner's visual channel (searchArt; the pure search is scanner/art-search.ts)
│   │   ├── hash-art.ts              # CLI for the art-hash job (npm run hash-art)
│   │   ├── scan-logs.ts             # Server-side scan logs: data/scan-logs/<day>/*.log, 30-day retention, list/read for /admin
│   │   ├── cardtrader-xls.ts        # Cardtrader order export (.xls/.xlsx) -> purchase-price rows; the only place that parses an uploaded workbook (DB-free, unit-tested)
│   │   ├── schema.ts               # Drizzle ORM table definitions
│   │   └── seed.ts                  # Scryfall import script
│   ├── types.ts                     # Card, CardFace, CollectionCard, Tag, PriceHistoryEntry, SearchFilters + parseCardFromDb()
│   └── utils.ts                     # formatPrice, displayPrice, priceDivergence, formatManaCost, conditionLabel, getRarityColor, priceDate (+ utils.test.ts)
└── routes/
    ├── +layout.svelte               # Nav bar, footer (Impressum/Datenschutz)
    ├── +layout.server.ts            # Passes user to all pages via layout data
    ├── +page.svelte                 # Homepage with stats
    ├── admin/                       # Admin dashboard (users, DB stats, scan logs) — admin only
    ├── api/
    │   ├── import/+server.ts        # Admin DB-init trigger
    │   ├── scan-log/+server.ts      # POST: /scan uploads its debug log (public, rate-limited); GET: admin list / read
    │   └── prices/
    │       ├── +server.ts           # Price update trigger
    │       ├── card/+server.ts      # Single card price history API
    │       └── data/+server.ts      # Bulk prices data API (stats, topCards, profitHistory)
    ├── auth/                        # Google OAuth flow
    ├── cards/                       # Public card browser + detail pages
    ├── collection/                  # Collection CRUD, import, export (the old /collection/scan redirects to /scan)
    ├── scan/                        # Card scanner (public, no auth required)
    ├── wishlist/                    # Wishlist CRUD with priority
    ├── prices/                      # Price charts, top cards, profit/loss
    ├── tags/+server.ts              # Tag CRUD
    ├── login/                       # Login page
    ├── impressum/                   # Legal: Impressum
    └── datenschutz/                 # Legal: Datenschutzerklärung
```

## Key Routes

| Route | Purpose |
|-------|---------|
| `/cards` | Browse/search all cards (FTS, color/type/rarity/set filters, sorting, pagination, unique toggle, configurable page size) |
| `/cards/[id]` | Card detail (reprints, price history chart, collection/wishlist status) |
| `/scan` | Card scanner — public, no auth required. Adding to collection requires login |
| `/collection` | User's collection (search, sort by name/date/price/profit/set, tags, edit modal, purchase price tracking) |
| `/collection/import` | Moxfield CSV import (sync or append mode) |
| `/collection/export` | Moxfield CSV export |
| `/wishlist` | Wishlist with priority, collect-to-collection with purchase price prompt |
| `/prices` | Collection value over time (Chart.js), profit/loss chart, top cards with per-card price history popup. Data loaded async via `/api/prices/data` with skeleton loading state |
| `/admin` | Admin dashboard — user management, DB statistics, scan logs (admin only) |
| `/collection/scan` | Retired in Phase 4 — redirects to `/scan` (hooks.server.ts) |
| `/api/prices/data` | Bulk prices data (stats, topCards, profitHistory, usdToEur) — used by `/prices` for async loading |
| `/api/scan-log` | POST (public, 30/min per address, ≤ 512 KB): the scan page stores its debug log server-side; GET (admin): `?limit=` list, `?name=` one log |
| `/api/import` | Admin-only DB init trigger |

## Important Patterns

### CardPreview (Portal Pattern)

`CardPreview.svelte` renders a hover preview by creating a `<div>` directly in `document.body`. This avoids CSS `transform` creating a containing block that clips `position: fixed` elements.

### Card Scanner Flow

1. User uploads photo → the image is downscaled to at most 1600 px on the long edge (`DETECT_MAX_EDGE`) for detection only — the six strategies on a 12-megapixel phone photo took several seconds, and card edges don't need that resolution. Candidates are mapped back to full resolution before the warp, so OCR still samples the original pixels. OpenCV detects card rectangles via **6 detection strategies**:
   - Canny edge detection with multiple thresholds (3 parameter sets)
   - Adaptive threshold segmentation (for tightly packed cards)
   - Histogram equalization + Canny (for low-contrast cards)
   - Otsu global threshold
   - Color saturation mask (for colored card borders)
   - Inverted Otsu threshold (for light cards on light backgrounds)
2. Filters for 4-corner contours with MTG aspect ratio (0.5–0.9) that are also *card-shaped quadrilaterals* (`isPlausibleCardQuad()` in `quad.ts`: convex, corners of 50–130°, opposite sides alike — a phone's manual capture had warped bow-ties and triangles with a fourth point), IoU deduplication, containment and size filters. **Strategy 7, a fallback for a lone card:** when at most one candidate is left, the detection copy is scaled to ~360 px, blurred 9×9 and scanned with Canny 15/45 (`findCardQuads()`, the live detector's coarse pass) — on a woven play mat or any dark textured background the six strategies find nothing, the image frame itself, or only the card's art / text box, because the texture's edge mesh fuses with the card outline; at the coarse scale the texture averages out and the border/background step survives. The outline replaces a lone candidate that is the image frame or one of the card's inner boxes (`isInnerBoxOf()`); it never runs on spreads, where the coarse scale merges touching cards into card-shaped blobs. The hold-out photo of a black card on a dark cloth went from "the image frame is the card" to identified with its printing. **Multiple mode** adds spread-aware steps from `src/lib/scanner/grid.ts` (pure, unit-tested): a dimension-consistency filter on the *oriented* edge lengths (short and long side of the quad, so a tilted card keeps its true size while its bounding box would grow; candidates more than 15% off the median are partial cards or two touching cards merged into one blob and are dropped), then **grid inference as a hypothesis**: the surviving cards are indexed on a lattice two ways — neighbour links (nearest card to the right / below within half a card of the axis, gaps bridged by whole pitch steps; tolerant to rotation and perspective) and 1-D clustering of the centres (for sparse detections where hardly any card has a direct neighbour) — a mapping grid index → image is fitted to each (affine, or a homography when at least six cards are on the lattice and it fits clearly better), cards further than 25% of a pitch from their cell are off-grid, every card is re-indexed to its nearest cell under the fit, and the indexing that puts more cards on its lattice wins; a lattice with more than 20% off-grid cards or cards wider than their pitch is rejected and nothing is added. Every unoccupied cell, one row/column beyond the detected extent included, becomes a perspective-correct quad and is kept only with texture inside (grey-level std ≥ 20, so blank paper is ignored) and less than 30% overlap with a detected card; nothing is filled to an expected count. Touching sideways cards in a phone photo went from 6/10 and 12/15 detected to 10/10 and 15/15.
3. Corner ordering via `orderCornersForCard()`: the short edge becomes the top of the warp, so sideways cards come out upright without a separate rotation step
4. Corner expansion (~5% outward from the quad centre) + perspective transform to the base size 488×680, or up to 2× that when the quad covers more source pixels (`WARP_MAX_SCALE`: camera photos, a card filling a live frame), so the ~1.5 mm collector line keeps its native pixels instead of being downsampled before OCR. Result thumbnails stay at base size (`cardThumbnailUrl`). The expansion is deliberately **not clamped** to the frame: `warpPerspective` pads out-of-frame samples with black, so a card that touches the image edge (typical for hand-held live captures) keeps the same ~3.5% margin as any other and the fixed crop windows below still line up. Clamping used to make such warps tight on the card and pushed the collector line out of its crop window.
5. **OCR windows from the warp itself** (`src/lib/scanner/crops.ts`): row/column mean-intensity profiles of the warped card locate the inner edges of the black border (leading/trailing dark runs with a per-profile adaptive threshold, 40% of the 5th→95th percentile range); the name band starts just below the top edge (8.5% tall) and the collector window just above the bottom edge (8% tall, covers the border). The collector text printed in the bottom border can lift a row mean above the threshold, so the bottom run bridges a bright stretch of up to 2.5% of the warp (one text line): without the bridge the run ended at the artist line of M15-frame cards, the window slid down and the number line above it fell out — the phone read "ORI DE LARS GRANTWEST" for three captures of a German War Horn (2026-09-18), and on clean card images the run stopped at a text line for 4 of 13 cards. Measured: hold-out identity 18 → 19 and printing 7 → 9 of 26 (the rotated strip of the flavor-name Counterspell now reads "004 FCA", which supports its 8-bit artwork, and Borne Upon a Wind's "0044" settles LTR #44), development set unchanged (103 / 83, 0 wrong). Loose, tight and grid-inferred warps therefore all read the right rows. Cards without a dark border (white-bordered, some showcase frames) fall back to the fixed windows (name x 6–74%, y 5.5–13.5%; collector strip left half, y 89–99%).
6. **Name OCR (evidence only)**: Tesseract.js (PSM 7) on the name band, upscaled to 1.5× the base warp (`NAME_OCR_SCALE`) so the letters land in Tesseract's ~30–50 px sweet spot — the old 6× crops produced ~140 px letters and made the line finder return nothing for perfectly legible names → batched API search by name. `searchByName()` tries exact (canonical name, `Front // Back` records whose front is the query, and `card_faces` names — the scanner reads the face printed on the card, the database stores the canonical string) → FTS prefix on all words → LIKE → **OCR-tolerant fallbacks restricted to the name column**: any word (OR), word stems (first 4 letters of 5+-letter words), then the word core with the first one or two and the last character dropped (`CTenderize`, `Jrenderize` → Tenderize), and as a last resort an edit-distance scan over every distinct name and face (`fuzzyNames()`, bigram prefilter, similarity ≥ 0.5; `wmotorion` → Immolation, `Fost wranger` → Skaab Wrangler). `bestNameMatch()` scores every alias of a name (canonical string and each face, `nameAliases()`) and returns the canonical name; it also scores the matching word-prefix when only trailing junk drags the score down (`looksLikeOcrJunk` guard, so "Fire Ball" never collapses to "Fire"). Against the full catalogue two more things matter (Round 10): the OCR-tolerant paths pool their rows and the server ranks the distinct names by that same similarity before cutting the list (`rankNameMatches()`, 20 names, 10 printings each), because the first path to answer used to return 20 *rows* that could all be printings of the wrong names ("Escave Tunnel" → Ice Tunnel, Escape Tunnel beyond the cut); and Scryfall's *art-series* records (`layout = 'art_series'`, named "X // X") are excluded from every scanner query — they matched a scanned name as often as the card itself. A pass accepts a name only when `nameIdentifies()` holds (score ≥ 0.6, an exact read for a name or face shorter than six characters, and below 0.8 at least one real word in the text), so "Boa" no longer stops the later passes as the token Boar; the best three names of every pass are recorded as candidates. Cards still unresolved get further passes (**Phase 2a**), each reading a different subset of name bars: PSM 7 on an Otsu-binarised copy of the band (dark text on white, a light-on-dark bar is inverted first), PSM 13 (raw line) on a binarised 2× crop (`NAME_OCR_SCALE_ALT`), PSM 13 on the gray 2× crop (binarisation erases light text on busy showcase art), and last **PaddleOCR PP-OCRv4 recognition** (`src/lib/scanner/paddle.ts`, onnxruntime-web WASM, ~25 MB loaded lazily on first use, so only stubborn cards pay for it). Measured on 75 real-photo cards (`ocr-scale-experiment.mjs`, `ocr-preprocess-experiment.mjs`, `ocr-engine-experiment.mjs`): gray PSM 7 at 1.5× reads 49, binarised 57, the union of the Tesseract passes 68; PaddleOCR alone 64 where all Tesseract passes together read 65, and the union of both engines 72. **Every candidate of every pass is recorded** in `card.nameCandidates` with its score and pass; a score ≥ 0.6 marks the card as name-resolved for the later passes, but the decision is made by the fusion in step 8.
7. **Upside-down retry (Phase 2b)**: `orderCornersForCard()` cannot tell a card's top from its bottom when the card lies sideways or upside down (both short edges are geometrically identical): for a spread rotated one way *every* card leaves the warp rotated 180°. Every card the name search didn't resolve is re-cropped from the 180°-rotated warp (`extractOcrCrops`, the same helper the main loop uses), OCR'd (single-line, then raw-line pass) and searched again; on success the rotated crops replace the originals. Cards still unresolved keep the rotated crops as `altNameUrl/altBottomUrl/altCroppedUrl` (+ `*2` variants) for the next phase.
8. **Bottom OCR and evidence fusion (Phase 3)**: Tesseract.js (PSM 6) reads every card's collector strip at 4× the base warp (`BOTTOM_OCR_SCALE`; 18 of 75 strips read at the old 6×, 24 at 4×, 27 with a second 2× pass); cards without a unique name hit also get the 2× strip (`BOTTOM_OCR_SCALE_ALT`) and both rotated strips. **Every strip becomes a reading** (`parseCollectorInfo()`: set code, collector number with its `numberSource` — fraction / number-total pair / rarity-prefixed, incl. a letter glued to the digits like `C0047` / padded, a standalone zero-padded four-digit token like `0085` / weak —, the rarity letter, the language code and a foil hint; a mixed token whose letters are all digit lookalikes (`O08S`) is never taken as a set code) in `card.readings`; the strip that parses best only decides which orientation the UI *shows*. `src/lib/scanner/resolve.ts` (`resolveCard()`, pure and unit-tested) then fuses name candidates and readings per card, with every printing of every candidate name (`{ printings }` batch, no date cut-off) and every set+number lookup (`{ lookups }` batch incl. `setKnown`) prefetched in two round trips: **identity** and **printing** each get a state — `confirmed`, `likely` (one tap), `unknown` (a suggestion may be attached) or `conflict`. Rules: a name that `nameIdentifies()` accepts identifies the card and the footer picks the printing via `disambiguateReprints()` (exact set + full number with suffix first, then a unique set — one glyph off counts when unique —, then a unique *structural* number; never arbitrary digit sequences or copyright years). Below `NAME_CERTAIN` (0.8) the name is *uncertain* and, in this order: an exact structural number corroborates it; a structural reading that points exactly at another card whose name also fits the text beats it (`confirmed` when the set code is real, `likely` via the majority set — "pean Zia Cavalry" + `C 0156 TMT EN` is Mechanized Ninja Cavalry, not Llanowar Cavalry); the looser footer matches corroborate it; a real set code the name was never printed in, or a structural number none of its printings match, demotes it to `likely` unless a lesser candidate joins with that footer; a runner-up within `NAME_MARGIN` (0.1) on the whole text makes it a one-tap choice. A name ≥ 0.4 joined with a number that is compatible (exact, one substituted or one dropped digit) in the read or majority set and points at exactly one printing is `likely`, or `confirmed` when the number is exact and the set was read (or the card exists in one set only); a footer reading alone confirms only when it is *strong* (structural number + known set, or two variants agreeing) and plausible (rarity letter agrees — a letter any strip variant read next to the same number counts —, no name candidate ≥ 0.45 for a different card while the hit scores < 0.3, a weak number needs name agreement), and only when no other strong reading and no artwork up to 12 bits (that the scan does not also resemble the hit's own art) names a different card — then it is a one-tap offer with both (phone, 2026-09-18: German cards had one strip read ORI #194 and the other #104, or a single strip misread 137 as 132); a strong consensus reading that names a different card than a confident name is a `conflict`. Nothing resolved leaves the card `unknown` with up to three **suggestions** for one tap: a structural number-only hit (or a weak one with faint name agreement), the rarity-consistent printings one OCR error away from a structural number (`{ near }` batch, `nearBySetNumber()`), or the printings of an uncorroborated partial name (≥ 0.4). A second pass feeds the **majority set** of confirmed cards to the unsettled ones. Finish is `unknown` unless the single-card pixel check ran — no OCR engine in use tells the ★ from the • separator, so text-based foil hints are never trusted; language comes from the reading. Measured on the eight photos: 0 wrong identities and printings against the distractor DB (103 of 104) and against the full catalogue (95 identities, 70 printings, 9 one-tap offers; the open printings are same-set variants and same-number reprints with an unreadable footer). **Visual channel (Phase 3, WP3.2):** every warped card is hashed exactly like the reference images (`hashArtPixels()`: luminance, box-filter resize, 32×32 DCT, 64 bits) over the reference box moved 2 % inwards (`artBoxOnWarp()` — the warp keeps ~3.5 % of background around the detected quad, and with the reference box as-is the same artwork measured 12.3 bits away on average, with the shift 9.2; `art-box-experiment.mjs`), upright and rotated 180°; the `{ artHashes }` batch returns the printings within `ART_LIKELY` (12) bits from the server's in-memory index (`src/lib/server/art-index.ts`, a Hamming scan over ~115k entries takes about a millisecond; the phone never downloads the table), and the page then fetches every printing of the matched names. In the fusion an unambiguous match (no second artwork within 4 bits) identifies the card on its own only at ≤ 6 bits (`ART_CONFIRM_ALONE`); up to 10 bits (`ART_CONFIRM`) it needs support — a name candidate ≥ 0.4 for the same card, a footer reading that fits one of its printings (exact structural number, or a real set code the name was printed in), or, in a spread, a printing in the majority set. A *certain* name that reads differently makes it a `conflict`; a structural footer number that fits none of the name's printings (not even one digit off) drops the match altogether when the number is reliable — a strong reading, or the same number read by two strip variants (a single misread, "RRR M220 ORD" for the 243/272 of a German War Horn, dropped the right 8-bit artwork and left Briarhorn as the one-tap offer) —; an unsupported 7–10-bit match never confirms — against an uncertain name that reads differently it becomes a one-tap offer (artwork first), otherwise it is offered at the very end. The reason is a wrong identity on the phone (2026-09-17): a Rabid Attack (SOS #96) with an unreadable name bar was *confirmed* as "Caduceus, Staff of Hermes" by a 10-bit match of the rotated hash, although the footer had read 0096 and Caduceus is #2 / #173 — with 114k references and two hashes per card a chance match at 10 bits is not rare enough to stand alone. A match ≤ 12 bits plus a name candidate ≥ 0.4 for the same card confirms as before, so does a match ≤ 12 bits plus a structural footer number read exactly as one of its printings (in the set the strip names, or with the printed rarity letter), and the artwork alone does nothing beyond 10 bits — against 8.5k hashes the nearest artwork at 12–14 bits named a different card in 7 of 15 cases. Cost of the stricter rule: the development set is unchanged (103 / 83; one card is carried by the majority set), on the hold-out set the flavor-name Counterspell (8 bits, no name, mixed pile) is now a one-tap offer (identity 19 → 18 of 26). The artwork never picks a *printing*: same-artwork reprints and variants sit 0–8 bits apart (MID vs Double Feature, regular vs extended frame), so the printings of an identified name are only narrowed to those whose reference art lies within 16 bits of the nearest one (`artPool()`, `ART_SAME_GAP`; different artwork measured 20–36 bits behind; printings without a hash always stay), and the footer decides among what is left. A first version confirmed the single printing the search radius returned and thereby turned Lantern Flare VOW #23 into the extended-art #351 — the radius is not the set of printings with that artwork. With the full table (112 772 printings + 1 594 back faces, 2026-09-17): full catalogue identity 95 → **103**, printing 70 → **83** of 104, 0 wrong; the seeded DB with the same hashes imported **104 / 104**. Every nearest artwork at ≤ 10 bits was the right card (91 of 91 over the development and hold-out photos), at 12 bits only 10 of 16 — hence the agreeing name a 12-bit match needs. **Cards printed in another language** (phone, 2026-09-18: German Magic Origins and Battle for Zendikar cards): the catalogue holds English names only, so a German name bar matches English names by coincidence ("Kriegshorn" → Briarhorn 0.60, "Chandras Entflammen" → Chandra's Outrage 0.65, "Krleghon" → Legion 0.63) and the junk read of a name bar vetoed a correct footer (Kothophed, ORI #104: "SNF Ee TC" → Sunfire Torch 0.54). When a footer reading names a real set and a language other than English, name candidates below `NAME_CERTAIN` are ignored — neither evidence for a card nor against a footer reading or an artwork — and the footer and the artwork decide; a certain read still counts ("Pia und Kiran Nalaar" 0.95). A join no longer uses a stray digit when a structural reading of the same card fits none of the candidate's printings (a "5" from the rotated strip joined Endless Atlas C18 #55 although the upright strip read "103/272 R"). Measured on 28 synthetic scenes of the seven German cards on the dark mat (`make-mat-scenes.mjs --cards`, live pipeline, full catalogue): confirmed right 17 → 18, wrong one-tap offers 3 → 2, **wrong confirmations 0 → 0** — the language rule alone had produced 4, which is why the footer checks above came with it; development and hold-out sets without a wrong identity or printing.
9. **Foil detection**: text-based detection from the separator char between set code and language on the bottom line (`*` = foil, `.` = non-foil), parsed from the Tesseract bottom OCR.
10. **Result states in the UI**: `found` cards carry a green "Confirmed" chip (plus "Printing?" while several printings are listed — picking one confirms it); `likely` and `conflict` cards list their candidates with an "Accept" button and a "Not this card" link; `not_found` cards show the suggestion ("Could be …", Accept) and the manual search prefilled with the best name candidate. The finish toggle cycles unknown → foil → non-foil. Card blocks expose `data-state`, `data-printing-state` and `data-finish` for the harness.
11. Manual search fallback for unidentified cards
12. Select all / import all buttons for bulk adding (auth required) — only *importable* cards: identity confirmed and exactly one printing established (`isImportable()`); nothing is imported via the first list position.
13. **Copy for Moxfield**: generates text in `1 Name (SET) number` format for importable cards, appends `*F*` only for a confirmed foil finish
14. **Debug log**: Collapsible "Debugger" section shows timestamped log of every scan step (detection strategies, OCR text, similarity scores, set/number parsing, reprint disambiguation). Includes "Copy Log" button for sharing. **Every scan also uploads its log to the server** (`POST /api/scan-log`, text only, never a photo; fire-and-forget at the end of `processImage`, plus a `sendBeacon` when a live session is left without a capture so its `[live]` lines survive): `src/lib/server/scan-logs.ts` stores it as `data/scan-logs/<UTC day>/<HHMMSS>-<id>.log` — one JSON header line (mode, source, summary, counts, wall time, user agent, user id when signed in, app version, detector, worker build, the last "Scan complete" tail, best-frame count) followed by the text — keeps 30 days, and `/admin` lists the last 50 with one-click viewing. The files are readable over SSH without opening the database, which is the point: a phone scan can be analysed without copying the log by hand.

### Live Scanner (camera mode, `/scan` → "Live camera")

`src/lib/components/LiveScanner.svelte` streams the device camera and auto-captures when the scene holds still. Only `/scan` has this mode (the old `/collection/scan` redirects here).

- **Viewfinder follows the stream.** The container's `aspect-ratio` is bound to `videoWidth / videoHeight` (updated on `loadedmetadata` and `resize`, so it tracks device rotation), capped at `70vh`. A phone held upright therefore gets a portrait preview. Previously the box was hard-wired to 16:9 and the overlay scaled x and y independently, which squashed an upright card into a landscape outline — the scanner looked as if it wanted the card in landscape.
- **Overlay mapping** goes through `fitContain()` (uniform scale + letterbox offset, same as CSS `object-fit: contain`) and renders at `devicePixelRatio`.
- **Per-frame detection** (`createQuickDetector()` → `quick-rects.ts`, ~6 fps): the frame is drawn into a 720-px analysis canvas, its pixels are read back once and *transferred* to a Web Worker (`detect-worker.ts`) that runs its own OpenCV.js copy: two Canny passes (`findCardQuads()`): a *fine* one on the 720-px frame (blur 5, 50/150) and a *coarse* one on a ~360-px copy (blur 9, 15/45) — on a woven play mat the fine edge map is a mesh that fuses with the card outline, so the phone tracked the art box, the text box or a four-cornered patch of the mat instead of the card (scan logs 2026-09-17), while at the coarse scale the weave averages out and the step between border and mat survives. Every contour becomes four corners (4-point approximation, or the minimum-area rectangle when the contour is a 5–8-gon or fills that rectangle to 90%) and must pass `isPlausibleCardQuad()` (`quad.ts`: convex, corners 55–125°, opposite sides within 0.6, side ratio 0.55–0.88 measured on the quad itself, so a tilted card is judged like an upright one; an MTG card is 0.716), the area window (3–60% of the frame, contour *and* quad) and a content check: the 5th–95th percentile luminance spread inside the quad, sampled as 7-px window means, must reach 30 — a card runs from its black border to its bright text box (39–185 measured, the low end foils under glare), patches of the mat and sleeved card backs stay at 10–32. Both passes usually see a card on a plain table; the fine quad wins (`preferFine()`, sharper corners). `postFilterRects()` then drops whatever lies inside a larger candidate (the art and text box of a card), with two exceptions where the *container* goes instead: a rectangle that reaches the frame edge and holds a fully visible candidate that is not one of its inner boxes (a print on the mat, the table edge), and a blob of several cards (`isCardBlob()`: two touching cards are 126×88 mm, card-shaped again; its members are card-shaped and lie along its sides — a single card has at most one inner rectangle of card proportions, the art box, which spans only 0.85–0.93 of it). Candidates below 25% of the largest survivor are dropped. Measured on 102 synthetic frames with ground truth (real card images on the real mat texture, rotated, dimmed, blurred; `make-mat-scenes.mjs` + `live-detect-experiment.mjs`): dark mat 44 → **72 of 76** cards found with 20 → 3 false positives, plain black 8 → 13 of 13, light table 13 of 13 unchanged, ~40% more detection time per frame; on a dark mat the quad usually sits on the card's inner frame (5% inside the outline), which the warp's 5% expansion absorbs. The strictness is intentional: the live loop auto-captures whatever it tracks, and the looser full-pipeline thresholds let keyboard keys and other small rectangles qualify as "cards". Because the OpenCV work is off the main thread, the preview and the UI stay smooth while a frame is analysed; when the worker cannot start (no Worker support, script or OpenCV load failure, 30 s timeout) or dies later, detection continues on the main thread with the same code and the debug log says so (`detector: …`). The worker is a *classic* worker bundled by `scripts/build-detect-worker.mjs` (esbuild, IIFE, runs automatically before `npm run dev` / `npm run build`, output `static/scanner/detect-worker.js`, gitignored), because a Vite module worker cannot `importScripts()` the UMD OpenCV build; it resolves the OpenCV URL on the page, so the self-hosted `/vendor` copy works too. **The script has a fixed URL, so the page requests it as `detect-worker.js?v=<app version>`** (`version` from `$app/environment`, new with every build): production sits behind a CDN that serves static files with `max-age=14400`, and the first phone test after the dark-mat fix ran the *old* detector out of the browser cache for that reason — the page was new (its telemetry lines were there), the worker was not (`coarse pass 0` in every line, bow-tie quads the new code rejects). The bundle carries a build stamp (`__WORKER_BUILD__`, injected by the build script) that the worker reports when it is ready; the log shows `app version …` and `worker build …`, and both are in the scan-log header. Note for anyone touching the worker: the Emscripten module is a thenable whose `then` never settles — never `await` or resolve a promise with `cv` itself, poll `cv.Mat` instead.
- **Best-frame capture** (`quality.ts`, pure + unit-tested): every analysed frame is scored — variance of the Laplacian over the tracked cards (sharpness) discounted by the fraction of blown-out pixels (glare, all channels ≥ 250; zero score at 10%) — and the full-resolution copy of the best frame of the *current scene* is kept (the two full-res canvases are swapped, no pixel copies; a change of the scene signature resets it, and a best frame older than 2.5 s is replaced by the next frame). The capture hands that frame and its rectangles to the pipeline instead of whatever frame happened to be current when the stabiliser fired; the debug log reports its sharpness, glare and age. The badge shows "blurry, hold still" when the frame is less than half as sharp as the best recent one and "glare on the card" above 3% blown-out pixels — hints only, they don't block auto-capture (glare on a foil is often unavoidable).
- **Stability** (`SceneStabilizer`, pure + unit-tested): a rect is steady after 700 ms of continuous tracking with ≥3 detections and a centroid spread ≤5% of its long edge (floor 10 px). Time-based so slow phones don't wait longer than fast laptops; relative so hand jitter on a card filling the frame doesn't block forever. The "steady %" badge reaches 100% exactly when auto-capture becomes possible.
- **Guards:** a rect within 1.5% of the frame edge is drawn red ("card cut off at the edge") and blocks auto-capture; more than 12 tracked rects also block it ("too many rectangles"). Manual "Capture now" always works.
- **Capture hands the tracked rects to the pipeline.** `onCapture(canvas, rects)` → `processImage(canvas, presetRects)` builds the card candidates directly from them and skips the six full-resolution strategies (1–3 s on a phone). A manual capture while the scene is still moving passes no rects, so full detection runs as a fallback.
- **Pre-warming:** OpenCV.js loads *before* the camera is requested; if the CDN script fails, the component shows "Card detection unavailable" with a retry button instead of streaming a preview that can never detect anything. `loadOpenCV()` refuses re-attempts for 2 s after a failure (`force: true` for user-initiated retries) so no caller can re-inject the script tag several times a second. The Tesseract worker pool is created as soon as live mode is selected (`$effect` in `/scan`), so the first capture doesn't pay worker spawn + traineddata download on top of the OCR.
- **Capture cues** (`src/lib/scanner/feedback.ts`): scanning works without looking at the screen — a short tick (880 Hz, 35 ms buzz) the moment a frame is captured, so the card can be taken away, then a second cue when the pipeline has finished: a rising two-tone with a double buzz when every card of the capture was identified, one low tone with a long buzz when not (look at the screen or scan again). Sound is WebAudio oscillators (no asset, offline), vibration is `navigator.vibrate` — which Chrome-based browsers on Android have and **Firefox does not** (disabled on Android since Firefox 79, removed in 129; the owner's phone runs Firefox and got the sound only) and neither does iOS Safari; there the sound is the only cue, the "Vibration" switch is only offered where the API exists and a short "No vibration in this browser" note replaces it otherwise. "Sound" / "Vibration" switches sit next to "Auto-capture", are stored in `localStorage` (`mtg.scan.feedback`) and preview the cue when switched on. The audio context is unlocked by the tap that opens live mode and by any tap inside the component; everything is best effort and can never fail a scan. The page reports the result through the component's exported `notifyResult()`.
- **Camera constraints:** the ideal 1920×1080 is requested with *and* without a device id. With the device id alone (camera switch, resume after a pause) the phone came back at 480×640, the browser's default mode.
- **Pause / review mode:** "Pause camera" stops the video track (the browser's camera indicator goes out, the battery rests), collapses the viewfinder into a slim "Camera paused — Resume camera" panel and leaves the scanned cards right below it; nothing is detected or captured while paused. The detection worker survives the pause (no second OpenCV load), and so does the memory of the last captured layout, so resuming over the card that is still lying there does not capture it again. `data-status` on the component root exposes `live` / `paused` for the harness.
- **Telemetry:** every 3 s, and right before a capture, one `[live]` line reports the frames analysed, in how many a card was found and by which pass, the mean detection time and what kept auto-capture waiting (`no card found`, `not steady yet`, `card cut off at the edge`, `same card as the last capture`, `processing the previous capture`). It ends up in the uploaded scan log, so a slow phone session explains itself.
- **Re-arm:** after a capture the auto-capture stays off until the layout really changed — the cards left the frame (picked up and put back), a card moved by at least half its short edge, or the number of cards changed (`sceneDiffers()` in `stability.ts`, pure + unit-tested). The first version re-armed as soon as the scene fingerprint (`sceneSignature()`, centroids quantised to ~30 px cells) differed, which hand jitter does all the time: a phone captured the same card three times in a row, and because every jitter also reset the best-frame selector, the repeat captures came from worse frames with an unreadable footer. The best-frame bookkeeping uses the same coarse comparison now; the fingerprint only labels the scene in the log.

### Price Change Indicator

Collection and prices pages show purchase price vs current price with color-coded percentage (green = up, red = down). When only USD price exists and purchase price is EUR, USD is converted to EUR for the calculation.

### Async Page Loading (Prices)

The `/prices` page loads its skeleton immediately (server only returns auth + price status), then fetches heavy data (stats, topCards, profitHistory) client-side via `/api/prices/data`. Animated skeleton placeholders are shown during loading.

### Profit/Loss Chart

Prices page shows profit/loss chart with 3 datasets: profit/loss (filled), purchase price (dashed), current value. Warning banner shown when cards are missing purchase prices.

## Testing

- `npm test` — vitest over `src/lib/**/*.test.ts` (Node environment, fully offline): collector-line parsing, name similarity + OCR-junk/prefix matching, reprint disambiguation, evidence fusion, spread geometry (oriented dimensions, lattice indexing, affine/homography grid hypothesis, empty cells), frame quality and best-frame selection, scene stability, overlay geometry, price display/divergence helpers, the Cardtrader workbook parser (which also pins the patched `xlsx` build). Anything touching OpenCV/Tesseract/DOM or SQLite is deliberately kept out of these modules or behind thin wrappers so the pure logic stays testable. A test must never import a module that imports `src/lib/server/db.ts`: the database opens at import time, and two vitest workers creating a fresh `data/mtg.db` on CI locked each other out (`SQLITE_BUSY`) — hence `art-image.ts` / `art-search.ts` next to the DB-bound `art-hash.ts` / `art-index.ts`.
- `npm run check` — svelte-check (TypeScript + Svelte). CI runs `check`, `test` and `build` on every PR (`.github/workflows/ci.yml`).
- **Scanner harness** (`scripts/scanner-harness/`, see its README): drives the real `/scan` pipeline headlessly with Playwright — upload path (`harness.mjs --mode single|multiple photos/*.jpg`, optional `--expect` name lists per file, `--out` JSON with OCR texts and the full debug log) and live path (`live-harness.mjs` plays a Y4M clip as the fake camera; its log shows which detector ran — `detector: Web Worker` — and the best-frame line). `make-synthetic.mjs` renders synthetic MTG-like cards (single, 2×2 grid, sideways) so the whole chain (detection → warp → crops → OCR → matching → reprint disambiguation) runs offline with the self-hosted libraries and a DB seeded by `seed-test-db.mjs`. Reference results on the sandbox: single 1/1 in ~3 s, grid 4/4 in ~4.4 s, sideways 1/1 in ~4 s (Phase 2b), live 2/2 about a second after the scene settles. Chromium's fake camera crops portrait clips when the app asks for 1920×1080, so render live scenes in landscape.
- **Real photos**: eight phone/camera spreads (2x2 … 3x5, upright and sideways, touching cards, foils, EXIF-rotated) are the development set, measured against **two databases** (see the harness README for the two-server setup with `MTG_DB_PATH` / `DISABLE_PRICE_UPDATES`): the seeded DB with distractor printings at every plausible digit misread and the same number in every other set (`seed-test-db.mjs --distractors`; identity and printing 103 of 104, the last one offered as `likely`, 0 wrong; `baseline.json`) and the **full Scryfall catalogue** (115k printings, what production sees; with the art-hash table identity 103, printing 83 of 104, 20 printings left open for the user, 1 `likely`, **0 wrong** — 95 / 70 with 9 `likely` before Phase 3; `baseline-fulldb.json`; the local database needs the hash table for these numbers, `npm run hash-art` or `--import`). The full-catalogue number is the primary one: before Round 10 the same code produced 23 wrong identities there while scoring 103/104 on the seed. The harness scores printings, not just names (`expectations-real-photos.json` lists set + number per instance, every entry verified against the catalogue — eleven were wrong until Round 10), `--baseline` fails a run that regresses, and `rescore.mjs` re-scores a saved run after a ground-truth correction. Results per photo and the remaining failure classes are in `scripts/scanner-harness/README.md`. The photos are not in the repository (2–6 MB each); `expectations-real-photos.json` and `seed-cards.json` (exported from the catalogue by `export-seed.mjs`) let them be re-run from a local folder. `dump-debug.mjs` writes the detection overlay and every card's crops as a montage — the fastest way to see *why* a card failed. `art-box-experiment.mjs` saves every warped card of a photo and measures its art hash against the reference hashes for several box placements, and with `--printings` against every printing of the identified name (how the Phase 3 constants were chosen). **Live detector, offline:** `live-detect-experiment.mjs` runs `detectOnPixels()` — the code the phone runs per frame — in Node on still images (OpenCV.js from the npm package via `OPENCV_JS`), draws the result and, with `--truth`, scores it against known corners (`--old` scores another revision of the module on the same frames); `make-mat-scenes.mjs` builds those labelled frames from Scryfall card PNGs on a play-mat texture cut from a photo; `make-still-y4m.mjs` turns any still into a camera clip for `live-harness.mjs`, which is how the dark-mat cases are checked end to end (capture within a second, identified). `live-ux-check.mjs` plays such a clip and asserts the live UX: capture cue then result cue (recorded `navigator.vibrate` patterns and oscillator frequencies), pause (camera track stopped, viewfinder collapsed, cards still listed), resume without a second capture of the same card, and the stored sound preference.

## Coding Conventions

- **No stores** — data flows from `+page.server.ts` load functions or client-side API fetches
- **URL params** for filters/pagination (shareable, bookmarkable)
- **`invalidateAll()`** after mutations to refresh data
- **`fetch()`** with JSON body for client→server API calls
- **Parameterized SQL** — never string concatenation for queries
- **camelCase** for variables/functions, **PascalCase** for components
- **German UI** elements where noted (Impressum, Datenschutz)
- **No `<slot>`** — use `{@render children()}` (Svelte 5)
- **`onMount`** for one-time init (avoids `$effect` reactivity loops)

## External Services

- **Scryfall API** (`api.scryfall.com`) — Card data, bulk downloads, price data. Rate limit: 200ms between image downloads (the art-hash job's default; its `--delay` must stay above 100 ms, Scryfall's ceiling is 10 requests per second).
- **Google OAuth** — User authentication (PKCE flow via `arctic`)
- **OpenCV.js** — CDN loaded (`docs.opencv.org/4.9.0/opencv.js`) by default, card rectangle detection + foil detection (HSV analysis)
- **Tesseract.js** — CDN loaded (`cdn.jsdelivr.net`) by default, OCR for names and collector numbers
- **PaddleOCR PP-OCRv4 recognition via onnxruntime-web** — CDN loaded (`cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0`, model from `@gutenye/ocr-models@1.4.2`) by default, lazily on the first card no Tesseract pass could read (~14 MB runtime + ~11 MB model, cached by the browser); second engine for name bars only. The CSP's `connect-src` includes `cdn.jsdelivr.net` for the WASM/model fetches.
- **Self-hosting all of them** (`PUBLIC_SCANNER_ASSETS_URL`, see `src/lib/scanner/assets.ts`): `node scripts/scanner-harness/vendor-assets.mjs` fetches the same versions from npm (`@techstark/opencv-js@4.9.0-release.3`, `tesseract.js@5`, `@tesseract.js-data/eng`, `onnxruntime-web@1.30.0`, `@gutenye/ocr-models@1.4.2`) into the gitignored `static/vendor/` (`opencv.js`, `tesseract/`, `ort/`, `paddle/`); set the variable to `/vendor`. Needed for offline development and sandboxed CI, optional for production (no CDN calls, ~75 MB of static files). The CSP allows `connect-src data:` because OpenCV.js fetches its embedded WASM from a data: URL.
- **Frankfurter API** (`api.frankfurter.dev/v1/latest`) — USD/EUR exchange rate, cached 6 hours
- **Plausible Analytics** (`analytics.mtg-collector.com`) — Self-hosted, cookieless reach measurement (Plausible Community Edition). Snippet embedded in `src/routes/+layout.svelte` inside `<svelte:head>`. Tracks pageviews, referrer, browser, OS, device type, and country — only aggregated stats, no personally identifiable raw data, no cookies. Domain is hardcoded in the served JS file, so no env vars are required.

## Dependencies and Security Updates

- **`npm audit` is clean (0 findings, 2026-09-17) and should stay that way.** Fix findings on a development machine — `npm audit fix`, then `npm update <pkg>` for nested leftovers (`tsx` pinned a vulnerable `esbuild` that way) — and ship the changed `package-lock.json` through a PR. Run `check`, `test`, `build` and the scanner harness afterwards: an audit fix moves SvelteKit, Svelte and Vite by several minor versions.
- **Never run `npm audit fix` or `npm install` on the host.** The host installs with `npm ci` from the committed lock file; a changed lock file there dirties the checkout and blocks the next `git pull`. It also does not work: npm 10.9.7 (the host's, Node 22) aborts `audit fix` with `Cannot read properties of null (reading 'edgesOut')` — an arborist bug with `overrides`; npm 11 resolves the same tree. The lock file written by npm 11 installs fine with npm 10 (`npx npm@10.9.7 ci --dry-run`).
- **`xlsx` comes from SheetJS's own CDN, not from the npm registry** (`"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"`, pinned by the integrity hash in the lock file; no install scripts, no dependencies, Apache-2.0). SheetJS left the registry, whose copy is frozen at 0.18.5 with a prototype-pollution (< 0.19.3) and a ReDoS advisory (< 0.20.2), and npm reports "No fix available" for it. The library parses an *uploaded* file on the server (Cardtrader order export, `/collection/prices` → `src/lib/server/cardtrader-xls.ts`), so this was the one finding with a real attack path; nothing else reads the legacy binary `.xls` Cardtrader exports. A plain `npm install xlsx` brings 0.18.5 back — a unit test fails on any version below 0.20.2. To upgrade, install the new tarball URL from <https://cdn.sheetjs.com/>. `npm ci` needs that CDN once per machine; afterwards the npm cache serves the tarball by its hash.
- **`overrides` in `package.json`:** `cookie` 0.7.2 (SvelteKit still asks for `^0.6.0`, which has an advisory) and `esbuild` 0.25.4 for `@esbuild-kit/core-utils` (drizzle-kit's loader pins 0.18). Re-check both when those packages move.

## Database Migrations

New columns/tables are added via `addColumnIfMissing` in `src/lib/server/db.ts:initDb()` (PRAGMA-checked so real ALTER errors propagate):

```typescript
addColumnIfMissing('collection_cards', 'user_id', 'TEXT REFERENCES users(id) ON DELETE CASCADE');
```

Structural migrations beyond column adds (e.g. the FTS5 external-content rebuild and the `price_history` same-day dedup + UNIQUE index) are done in dedicated helpers that are idempotent and run on every boot.

## Backups

The app's state is two files under `data/`:

- `data/mtg.db` — primary SQLite database (+ the transient `-wal`/`-shm` companions when the DB is open).
- `data/secret-key.hex` — server-side secret for the keyed hashes that pseudonymise identifiers (contact form). It used to encrypt per-user Google Vision API keys as well; that feature is gone. Losing the file only rotates the hashes.
- `data/scan-logs/` — uploaded scanner debug logs, transient (30 days), not worth backing up.

Recommended backup flow (safe while the app is running, because SQLite is in WAL mode):

```bash
# Consistent snapshot of the DB, even under load (the directory is not part of the checkout)
mkdir -p backups && sqlite3 data/mtg.db ".backup 'backups/mtg-$(date +%Y%m%d-%H%M%S).db'"
# Snapshots are never overwritten (time-stamped names) and each is a full copy of the database:
# keep the two newest, or five deploys in two days leave 17 GB behind (3.4 GB each, 2026-09-17)
ls -1t backups/mtg-*.db | tail -n +3 | xargs -r rm --
# And the secret key alongside it
cp data/secret-key.hex backups/secret-key-$(date +%Y%m%d-%H%M%S).hex
```

A pre-deploy snapshot is a safety net for the deploy itself (a migration gone wrong), not the backup: the user data leaves the host every night in its own dump (see the vault's deployment notes), and the catalogue can be re-imported from Scryfall. That is why two snapshots are plenty.

For Docker deployments, mount `/app/data` as a volume and include it in your host's backup job. `.backup` creates a consistent copy even while writers are active — prefer it over `cp mtg.db`, which can capture a torn page mid-write.

## Roadmap & Open Points

Keep this section current when you change the scanner. It has three parts: the improvement programme (the plan), the history of what is done, and known limitations.

### Scanner improvement programme (planned 2026-09-16)

**Basis.** Eight real photos run through the harness: 87 of 104 names identified, 0 wrong, measured against the distractor DB — but *in-sample* (OCR scales and plausibility rules were tuned on these photos) and *name-level only*. An external code review of commit 9cfe928 (16 Sept 2026, not in the repository) reproduced four defects with the real modules and set an acceptance definition; its six regression tests fail 5/6 on the current code. Both sources are merged into the programme below.

**Round 10 (2026-09-16) — reality check against the full catalogue.** Phases 0–4 were measured in a sandbox against the seeded DB only. On a PC with the full Scryfall catalogue the unchanged Phase-4 code scored 78 / 55 of 104 with **23 wrong identities** (0 on the seed), and eleven of the 104 hand-written expected printings turned out wrong (verified against the catalogue and Scryfall's API; the seed had been typed from the same list). Fixed in this round without touching the seed baseline (103 / 103, 0 wrong): art-series records excluded, server-side candidate ranking, `nameIdentifies()`, footer-versus-uncertain-name rules and the runner-up margin in `resolve.ts`, engine-load deadlines. Full catalogue now **95 / 70 of 104, 25 printings open, 9 `likely`, 0 wrong**. The open printings are catalogue ambiguity (same-set variants, Double Feature reprints with identical numbers, The List, Forest) that only a legible footer or the user can settle; the 9 `likely` cards and the 9 misses are name-OCR ambiguity — the case for Phase 3. Real-device check (WP4.4), hold-out photos (WP0.4) and the host deployment are still open.

**Findings that drive the order** (all reproduced):

- The harness scores a bag of names; the printing is not checked (Bot Bashing Time exists as TMT #85 and as the PTMT #85p promo; a card left with both candidates counts as identified) and nothing fails the run.
- `disambiguateReprints()` matches arbitrary digit sequences before the exact set+number: `C 0085p PTMT EN` with set `ptmt`/number `85p` returns `tmt#85`; a copyright year `2009` selects a printing numbered 2009.
- Double-faced cards: production stores Scryfall's canonical name (`Beloved Beggar // Generous Soul`), the search and `bestNameMatch()` ignore `card_faces`, so a *perfect* read of the front face scores 0.50/0.44 and fails the 0.6 threshold. The harness seed uses simplified names and hides this. Name queries are also capped at the 10 newest printings (exact) / 20 rows, so the right printing of a much-reprinted card may not be among the candidates.
- `found` does not mean "printing confirmed": unresolved reprint lists are `found`, and "Import all" writes `results[0]` (the newest printing) into the collection; the Tesseract path stores finish `nonfoil` although it has no evidence.
- Local scanner findings (all addressed in Phases 1–2 except the bright-background windows): strip-score ties kept the first reading, extra strips only ran for cards without any name candidate, the Vision retry only saw the footer crop, `cropWindowsFromProfiles()` fails on bright backgrounds, 7 of the 17 misses were ~12 px collector digits (15 cards per phone photo).

**Target architecture** (evidence channels feed one decision):

```
photo / live frame -> EXIF-normalised -> detection (quads, orientation, quality)
  -> warp per card at native resolution
  -> evidence channels, in parallel:
       name OCR (single-line + raw-line, face-aware search)   -> identity candidates + scores
       footer OCR (4x, 2x, both orientations)                 -> set / number / rarity / language / finish readings
       visual match (art hash, later feature verification)   -> identity candidates + distances
  -> fusion (src/lib/scanner/resolve.ts, pure): identity + printing + language + finish,
     each confirmed | likely | unknown | conflict, with reasons
  -> UI: confirmed (green) / likely ("Accept?" one tap) / unknown (search prefilled) / conflict (both shown)
  -> bulk import and Moxfield export take confirmed + user-accepted cards only
```

**Measurement protocol** (acceptance definition, applies to every phase):

- Metrics per photo and in total: detected instances, identity correct, printing correct, wrong identity, wrong printing, missing, extra detections, `likely`/`unknown`/`conflict` counts, wall time, peak memory. Wrong automatic acceptances are the primary number; identity and printing are reported separately.
- Frozen conditions per baseline: commit, photo SHA-256 (`photo-inventory.json`), reference-data snapshot (seed export incl. distractors), OpenCV.js/Tesseract.js versions, constants. Before/after only under identical conditions.
- The eight photos are the development set. A hold-out set (WP0.4) is measured after each phase and never tuned on. Repeated shots of the same spread stay on one side of the split.
- "104/104" means every instance localised once and mapped to the verified printing automatically; a `likely` card confirmed by one tap is a different metric (assisted) and is reported as such.

#### Phase 0 — Measurement foundation (~4 h) — done

Status: WP0.1–WP0.4 done. WP0.4 (2026-09-16): six hold-out photos (`photo-inventory-holdout.json`, `expectations-holdout.json`, `baseline-holdout.json`), measured against the full catalogue and never tuned on — identity 16 / 26, printing 5 / 26, 11 printings open, 4 `likely`, **0 wrong**; the negative photo identifies nothing. New failure classes recorded in the harness README and under "Known limitations": flavor names, the collector number on its own footer line, a black-bordered card filling the frame on a dark cloth, old frames without numbers. Six expected printings still await the owner's confirmation (README).

- **WP0.1 Printing-level harness metric.** `expectations-real-photos.json` lists expected printings (`name`, `set`, `number`, optional `finish`) per photo; `harness.mjs` reports the metrics above, compares against a committed `baseline.json` and exits non-zero on any regression. Acceptance: a card left with several candidate printings counts as unresolved, a unique but different printing as wrong; a missing card is a miss even when it is correctly `unknown`.
- **WP0.2 Reference-data fidelity.** Harness seed from canonical data: names with ` // `, `card_faces` rows, real layouts; `seed-cards.json` regenerated from a full DB export (`export-seed.mjs`) instead of hand-typed rows; distractors extended cross-set (the same number in every other seeded set, so a misread set code like `YOW` for `MID` shows up as WRONG); `photo-inventory.json` (hashes, sizes, instance counts) committed.
- **WP0.3 Review regression tests.** Add the six tests as `src/lib/scanner/review-regressions.test.ts`, the five failing ones as `it.fails` until WP1.1/WP1.2 land, then flip them.
- **WP0.4 Hold-out photos (owner).** 5–10 new photos not used for tuning: double-faced cards, showcase/borderless frames, foils under glare, a 2×3 phone spread, single-card live captures, a mixed-set pile, an empty table (negative case). Expected printings verified by the owner. Done 2026-09-16 with six photos (see status above); the live-capture motif is still owed after the host deploy.

#### Phase 1 — Matching correctness (~12 h) — done

Status: WP1.1–WP1.6 done. Eight photos: identity 86 → 90, printing 85 → 90 of 104, unresolved printings 1 → 0, 2 `likely`, 0 wrong; the six review tests pass. Finish/language are fields on the scan result; the collection schema (WP5.4) still stores the boolean.

- **WP1.1 Reprint disambiguation order** (`pipeline.ts`): exact set + full collector number first (suffix preserved, only leading zeros normalised), then unique set, then unique number — and a number only when it comes from a structural parse (fraction, rarity-prefixed, pair; never an arbitrary digit sequence, never a copyright year). Acceptance: the four review tests pass; conflicting evidence yields `null`, not a guess.
- **WP1.2 Face-aware names.** `bestNameMatch()` scores the canonical name and each face (split on ` // `) and returns the canonical name; `searchByName()` matches face names (join `card_faces`, `name LIKE 'q //%'`); scan results show the visible face; the seed uses canonical names (WP0.2). Acceptance: the two DFC review tests pass; DSC00855's DFCs resolve by name against the canonical seed.
- **WP1.3 Identity-first candidate search.** Name queries return distinct identities (top 20 by relevance, all fallbacks), then *all printings* of an accepted identity (`oracle_id`, no date limit) for reprint resolution; inner-substring fallback for words with a glued or misread first letter (`CTenderize`, `Jrenderize` → Tenderize).
- **WP1.4 Evidence fusion module** `src/lib/scanner/resolve.ts` (pure, unit-tested; replaces the inline logic in `applyBottomMatch`, the weak-number guard, the majority-set fallback and `numberOnlyHitPlausible`). Inputs: name candidates with scores from every pass, footer readings from every variant (set, number, number source, rarity, language, foil hint), the majority set, printings per candidate. Rules: readings that agree across variants outrank a single reading; strong number + set + rarity agreement → printing *confirmed*; name ≥ 0.6 with a unique printing → *confirmed*; name ≥ 0.4 ∩ number within one edit or a dropped digit ∩ read or majority set → unique → *likely*; strong name and strong number that disagree → *conflict*, never silently one of them; weak number without name evidence → *unknown* with the candidate attached. Acceptance: distractor DB stays at 0 wrong; Dawnhart Rejuvenator, The Last Ronin's Technique and Null Group become `likely` or `confirmed`.
- **WP1.5 Result states in the UI and import.** Four states rendered distinctly; `likely` has a one-tap "Accept" with the printing prefilled; `unknown` opens the manual search prefilled with the best candidate; `conflict` shows both readings. "Select all", "Import all" and the Moxfield text take confirmed + user-accepted cards only; an unresolved reprint list is never imported via index 0.
- **WP1.6 Finish and language as fields.** Scan result gets `finish: 'nonfoil' | 'foil' | 'etched' | 'unknown'` and `language`; the Tesseract path yields `unknown` (badge "Finish?"); `*F*` in the Moxfield text only for confirmed foil; accepting a row confirms its finish. The collection schema change is WP5.4.

#### Phase 2 — OCR evidence quality (~8 h) — done

Status: WP2.1/WP2.2 were part of the Phase 1 fusion; WP2.3 (binarised and gray raw-line passes), WP2.5 (Vision gets name + strip) done; WP2.4 deferred — the remaining misses are OCR-level, not window placement (every unresolved card had its text inside the window); WP2.6 evaluated with `ocr-engine-experiment.mjs` and adopted as a last name pass (PaddleOCR reads 64/75 names alone, 72/75 together with Tesseract; its footer reading failed on the two-line strip and stays with Tesseract). Also added: `padded` number source, near-number and partial-name suggestions, edit-distance name fallback. Eight photos: identity 90 → 101, printing 90 → 101 of 104, 1 `likely`, 0 wrong.

- **WP2.1 Keep every footer reading** (4×, 2×, rotated, Vision) as evidence for WP1.4 instead of a single strip-score winner.
- **WP2.2 Extra strips for name-known cards** whose printing is unresolved (today only cards without a name candidate get them).
- **WP2.3 Name-band preprocessing variants** (Otsu binarisation, inversion for light-on-dark frames, CLAHE) as a third pass for unresolved cards, measured first with `ocr-scale-experiment.mjs --preprocess`. Target: the Skaab Wrangler class (legible crop, Tesseract fails at every scale).
- **WP2.4 Text-line localisation fallback.** When the profile/fixed windows yield no text, find the name bar and the collector line by edge-density projection over the top 25 % / bottom 15 % of the warp; the profile windows stay the fast path.
- **WP2.5 Vision retry input** (removed again on 2026-09-17 together with the whole Google Vision path)**:** name crop + footer crop (optionally the base-size warp) per failed card; results feed the fusion like any other reading; still only with the user's own key and the on-page toggle.
- **WP2.6 Second OCR engine evaluation** (PP-OCRv5 via ONNX Runtime Web): same crops, same experiment script; adopt only with a measured gain and no new wrong identifications; ~10–15 MB model, WASM/WebGPU. Evaluation only; adoption is a separate decision.

#### Phase 3 — Visual reference matching (~3–5 days)

Status: WP3.1 and WP3.2 done (2026-09-16), re-measured against the **full table** on 2026-09-17 (112 772 printings + 1 594 back faces; 54 images are unavailable at Scryfall). Eight photos against the full catalogue: identity 95 → **103 of 104**, printing 70 → **83** (79 with the first 20 sets), 20 open, 1 `likely`, **0 wrong** (acceptance: identity ≥ 100 with 0 wrong — met); seeded DB 103 / 103 without hashes, **104 / 104** with the hashes imported; hold-out identity 16 → 18 of 26 (the two flavor-name cards are recognised by their artwork), printing 5 → 6 of 26, 0 wrong. False matches: every nearest artwork at ≤ 10 bits was the right card (91 of 91), at 12 bits 10 of 16, so the constants stay. WP3.3 is not needed for identity. The table reaches the host as a 6.4 MB JSON export (3.5 MB gzipped) via `npm run hash-art -- --import`.

- **WP3.1 Art hash index (server) — done 2026-09-16.** `npm run hash-art` (`src/lib/server/art-hash.ts`) fetches every printing's Scryfall image (the `small` rendition, 146×204, a fifth of the bytes; the stored size as fallback), cuts the **same fixed art box** for every frame (`ART_BOX` in `src/lib/scanner/phash.ts`: x 8–92 %, y 11.5–53 % — what matters is that the reference and the scan cut the same region, not that it is exactly the art on every frame), resizes to 32×32 gray, and stores the 64-bit DCT hash as 16 hex characters in `cards.art_hash` (migration `0021`; back faces of double-faced cards in `card_faces.art_hash`, `'-'` marks an image that could not be hashed). One image at a time with the catalogue's 200 ms spacing, newest sets first, resumable (`art_hash IS NULL`), 114 420 images ≈ 6.3 h once; `--export` / `--import` move the hashes between databases as a small JSON file (dev PC → host), later runs only touch new cards. `--delay <ms>` overrides the spacing (the first full run finished at 105 ms, ~9.3 images/s, just under Scryfall's ceiling of 10 requests per second — the job waits for Scryfall, not for the CPU) and `--sets a,b` hashes chosen sets first. `sharp` decodes the images (new dependency). Measured on real images: the same artwork across printings 0–10 bits apart (MID vs Double Feature reprint 10, Persistent Specimen VOW vs J25 0), different artwork 26–32. The compact table for the client is WP3.2.
- **WP3.2 Client hash lookup — done 2026-09-16.** Hash of the warped card's art region on the client (plain canvas pixels, the shared `hashArtPixels()`, no OpenCV needed; the box moved 2 % inwards for the warp's background margin), Hamming search on the server over the in-memory index (`art-index.ts`, radius 12 bits, upright and rotated hash) → identity candidates with distances → fusion evidence: an unambiguous match ≤ 10 bits identifies, ≤ 12 bits with an agreeing name candidate confirms, the artwork alone never offers a one-tap. It decides *identity*; the footer decides the *printing* among the name's printings, narrowed only by artwork that is clearly different (`artPool()`, 16-bit gap). Details under "Card Scanner Flow", step 8.
- **WP3.3 Feature verification for the top-K candidates** (ORB/AKAZE + RANSAC homography): the vendored OpenCV.js 4.9 build exposes no features2d symbols, so this needs a custom build or a server-side verifier; optional, the hash alone should carry identity for most cards.
- Acceptance: identity ≥ 100/104 on the eight photos with 0 wrong identities; the hold-out set reported separately; printing rules unchanged. Measured 2026-09-16 (hashes of 20 sets) and 2026-09-17 (full table): 103 / 104, 0 wrong; hold-out 18 / 26, 0 wrong; the printing rules are unchanged apart from the narrowing above.

#### Phase 4 — Live scanner and robustness (~2 days) — done

Status: WP4.1, WP4.2, WP4.3 and WP4.5 done; WP4.4 is the owner's real-device check (checklist below). Eight photos: identity and printing 101 → 103 / 103 of 104 (the grid hypothesis recovers two more cards in the sideways phone spreads), 1 `likely`, 0 wrong, 76.9 s; synthetic single 1/1, grid 4/4, sideways 1/1; live harness 2/2 with `detector: Web Worker` and the best frame captured.

- **WP4.1 Best-frame selection:** keep the last N frames while the scene is stable, score sharpness (Laplacian variance over the card ROI) and glare (saturated-pixel fraction), capture the best one; show "blur"/"glare" hints in the viewfinder.
- **WP4.2 `detectCardsQuick` in a Web Worker** (OpenCV.js in the worker, ImageBitmap transfer) so the preview stays smooth on phones.
- **WP4.3 Grid inference as a hypothesis:** oriented edge lengths instead of the axis-aligned ±15 % median filter, evidence required per cell (kept), no fill to an expected count, perspective-tolerant checks.
- **WP4.4 Real-device verification (owner):** Android Chrome and iOS Safari checklist — portrait preview, auto-capture within ~1 s, red edge warning, a card filling the frame identified, 12 MP upload noticeably faster; tune `minStableMs`/`driftFrac` if needed. **Checklist for the owner** (open the Debugger section on `/scan` for the `[live]` lines): (1) the preview is portrait when the phone is upright; (2) the log shows `detector: Web Worker (OpenCV.js off the main thread)` — if it says `main thread (…)`, note the reason in parentheses; (3) the preview stays fluid while the outlines update (that was the point of the worker); (4) a single card held still: "steady" reaches 100% and identification fires within ~1 s, the log has a `Best frame of the scene: sharpness …, glare …` line; (5) move the phone while a card is tracked: the badge shows "blurry, hold still"; a foil under a lamp: "glare on the card"; (6) a card touching the frame edge shows the red outline and no auto-capture; (7) a card filling the frame is identified; (8) a 12 MP photo upload in multiple mode finishes noticeably faster than before Round 2; (9) `/collection/scan` opens `/scan`. Tune `minStableMs`/`driftFrac` (LiveScanner) or the best-frame `improveFactor`/`windowMs` (`quality.ts`) if (4) or (5) misbehave.
- **WP4.5 `/collection/scan`** consolidated onto the shared pipeline or retired in favour of `/scan` + add-to-collection.

#### Phase 5 — Architecture and CI (~1.5 days)

- **WP5.1 Orchestrator extraction:** phases, evidence collection and fusion move from the Svelte page into `src/lib/scanner/orchestrator.ts` (testable, the page only renders); OCR parameters passed per batch (`recognizeBatch(pool, urls, { psm, whitelist })`) so concurrent scans never share mutable worker state.
- **WP5.2 Harness in CI:** vendored assets job, photos from Git LFS or a fixtures bucket, baseline comparison, hold-out reported separately.
- **WP5.3 Frozen references:** reference-data snapshot, library versions and photo hashes recorded with every baseline (with WP0.2).
- **WP5.4 Collection schema:** `collection_cards.finish` (nonfoil/foil/etched/unknown) and `language`, the `foil` boolean kept in sync; import, export and UI updated.

**Order and dependencies.** 0 → 1 → 2 → 4 done in that order; 3 and 5 remain (5 can interleave with 3). WP5.1 is best done before Phase 3 so the visual channel lands in a clean fusion.

**Expected outcome on the eight photos** (in-sample; the hold-out set is the real check):

| After | Identity | Printing | Wrong |
|---|---|---|---|
| today | 87/104 | not measured | 0 (names) |
| Phase 0 | 87 | measured (promo case counts as wrong) | measured at printing level |
| Phase 1 | 90–93 | identity minus genuine ambiguities | 0, DFC path works in production |
| Phase 2 (measured) | 101 | 101 | 0 |
| Phase 4 (measured) | 103 | 103 | 0 (grid hypothesis; live quality is not measured by the stills) |
| Round 10, seeded DB (measured, corrected ground truth) | 103 | 103 | 0 |
| **Round 10, full catalogue (measured)** | **95** | **70** (25 open for the user) | **0** (23 before the round) |
| **Phase 3, full catalogue (measured, full art-hash table)** | **103** | **83** (20 open, footer still needed for same-art reprints) | **0** |
| Phase 5 | unchanged on stills; CI, schema | | |

**Decisions needed from the owner:** hold-out photos (WP0.4); the visual index data volume (once ~100k Scryfall images, several GB and hours on the server); and the two standing decisions below (price data quality, self-hosting the scanner libraries — now ~75 MB with the second OCR engine).

**Standing decisions (unchanged):**

- **Price data quality**: when `priceDivergence()` flags an EUR value, collection value and profit/loss still use it. Options: (a) keep as is and only flag; (b) fall back to USD×rate for flagged printings in `/collection`, `/prices` and the homepage KPI; (c) let the user pin a manual price per printing. (b) changes reported totals based on a heuristic, so it should be an explicit product decision.
- **Self-hosting the scanner libraries in production** (`PUBLIC_SCANNER_ASSETS_URL=/vendor`, ~50 MB static files, no CDN calls, Apache-2.0 licences with attribution). The mechanism exists; this is a deployment/privacy decision.

### Done

- Phone session 2026-09-18 (German Magic Origins / Battle for Zendikar cards on the dark mat, 15 captures, 7 confirmed): cards printed in another language no longer take uncertain English name matches as evidence, footer-only confirmations are checked against the rarity letter of every strip, disagreeing strips and a contradicting artwork, an artwork up to 12 bits plus an exactly read footer number confirms, a single misread number no longer drops an artwork, and joins ignore stray digits against a structural reading. The footer window bridges the collector text in the bottom border (the number line of M15-frame cards fell out), and a frame whose card touches the edge never becomes the best frame. Development set unchanged (103 / 83, 0 wrong), hold-out 19 / 9 of 26 (was 18 / 7), German scenes: 0 wrong confirmations, wrong one-tap offers 3 → 2.
- `npm audit` from 10 findings (6 high) to 0 (owner request 2026-09-17): lock-file updates for SvelteKit 2.56 → 2.70, Svelte 5.57, Vite 7.3.6, vitest 4.1.11, devalue, nanoid, postcss and the `esbuild` nested in `tsx`; `xlsx` 0.18.5 (registry, unfixable there) replaced by SheetJS 0.20.3 from the vendor's CDN, its parser moved into a tested module. Scanner unchanged against the upgraded production build (103 / 83, 0 wrong; live UX check 15 / 15).
- Google Vision removed completely (owner decision 2026-09-17): `/api/ocr`, the per-user API key in `/settings` with its encryption helpers, the retry toggle and Phase 3b in `/scan`, the usage statistics in `/settings` and `/admin`, the CSP entry and the privacy-policy passages; the privacy policy now describes what the scanner really sends (recognised text, the illustration fingerprint, the 30-day text-only scan log). The database keeps the unused column and table.
- A wrong identity on the phone fixed (artwork alone confirmed a 10-bit match of the rotated hash against a correctly read footer number): art-only confirmation needs ≤ 6 bits, 7–10 bits need a name, the footer or the majority set, a contradicting footer number drops the match. Resume after a pause keeps the full camera resolution; the UI says when a browser cannot vibrate (Firefox, iOS Safari).
- Live scanner UX (owner request after the first good phone session): audible and haptic cues at the capture and at the result, with switches that stick; a pause / review mode that releases the camera and keeps the results. Checked headless with `live-ux-check.mjs` (15 assertions).
- The detection worker is requested with the app version as a query and reports its build stamp (scan log header: `version`, `workerBuild`): behind the CDN the fixed-URL script was cached for four hours, so a phone kept running the old detector after a deploy.
- Live detection on a dark woven play mat (phone session 2026-09-17: long waits, the art box or text box captured as the card, patches of the mat captured, bow-tie warps from manual captures): coarse second Canny pass, card-quad sanity and a content check in the live detector, containment rules that tell inner boxes from background rectangles and card blobs, quad sanity and a coarse fallback for a lone card in the upload pipeline, live telemetry in the scan log. Synthetic mat frames 44 → 72 of 76 found, false positives 20 → 3; the hold-out black card on a dark cloth is identified with its printing (hold-out identity 18 → 19 of 26); development set unchanged at 103 / 83, 0 wrong.
- Phase 3, WP3.2 — the artwork as an evidence channel: client-side hash of the warped card (box moved inwards for the warp margin), server-side Hamming search over the in-memory index, fusion rules for identity by artwork (unambiguous ≤ 10 bits, or ≤ 12 with an agreeing name) and artwork-narrowed printing lists that never exclude a same-art reprint. Full catalogue with the full hash table: identity 95 → 103 of 104, printing 70 → 83, 0 wrong; seed with hashes 104 / 104; hold-out identity 16 → 18 of 26; no false nearest artwork at ≤ 10 bits against 114k hashes.
- Server-side scan logs (`/api/scan-log`, `data/scan-logs/`, `/admin` list) so phone scans can be analysed without copying the log; live auto-capture re-arms on a real layout change instead of the jittery fingerprint (a phone had captured the same card three times, the repeats without a readable footer).
- Round 10 — the full catalogue: ground truth of the eight photos verified against the database (eleven corrections, `seed-cards.json` now exported from the catalogue), the harness drives two dev servers (`MTG_DB_PATH`, `DISABLE_PRICE_UPDATES`, `HARNESS_URL`, `rescore.mjs`, `conflict` bucket), and the name channel was hardened for a 38k-name pool: art-series records excluded, fuzzy candidates ranked server-side, `nameIdentifies()`, footer-versus-uncertain-name rules, runner-up margin, top-3 candidates per pass, engine-load deadlines. Full catalogue 78 / 55 with 23 wrong → 95 / 70 with 0 wrong; seed baseline unchanged at 103 / 103.
- Phase 4 of the programme: grid inference as a validated hypothesis (`grid.ts`: oriented dimension filter, lattice indexing by neighbour links or 1-D clustering, affine/homography mapping, evidence per cell, no fill to a count), best-frame capture with blur/glare hints in the live scanner (`quality.ts`), per-frame detection in a Web Worker with its own OpenCV copy and a main-thread fallback (`quick-rects.ts`, `detect-worker.ts`, bundled by `scripts/build-detect-worker.mjs`), `/collection/scan` retired in favour of `/scan`. Eight photos: 101 → 103 of 104, 0 wrong.
- Phase 2 of the programme: binarised and gray raw-line name passes, PaddleOCR PP-OCRv4 as a lazily loaded last name engine (WASM, CDN or self-hosted), padded collector numbers and lookalike set-code guard, edit-distance name fallback, up to three one-tap suggestions (structural number, one digit off with matching rarity, partial name), Vision retry with name and strip. Eight photos: identity and printing 90 → 101 of 104, 0 wrong.
- Phase 1 of the programme: evidence fusion (`resolve.ts`) with confirmed / likely / unknown / conflict states for identity and printing, face-aware names (`Front // Back` records match their visible face), printings without a date cut-off, word-core search, safer reprint disambiguation (exact set+number first, near set codes for a certain name, no digit-sequence guessing), finish and language as fields, one-tap accept for likely cards, bulk import limited to established printings. Eight photos: identity 86 → 90, printing 85 → 90, 0 wrong.
- Phase 0 of the programme: the harness scores printings (set + number) with a committed baseline and a failing exit code; the seed carries canonical double-faced names with `card_faces`; distractors cover misread set codes; the review's regression tests are in the suite.
- OCR input size fixed: name crops at 1.5× the base warp plus a raw-line (PSM 13) pass at 2×, collector strips at 4× plus a 2× pass for unresolved cards (the old 6× crops were far too large for Tesseract); the warp itself runs at native resolution up to 2×. Real photos 76 → 87 of 104, scans ~20% faster.
- Number-only identifications are checked for plausibility (dropped-digit downgrade, name evidence incl. the best unaccepted candidate, rarity letter); the harness DB can be seeded with distractor printings so digit misreads count as WRONG. 0 wrong on the eight photos (was 2 against the distractor DB).
- Real-photo verification with the harness: 44 → 76 of 104 cards across eight spreads (sideways phone photos from 0/6 and 2/15 to 8/10 and 10/15), no wrong identifications left in the checked photos.
- Spread-aware detection in multiple mode: dimension-consistency filter, grid fill with edge-row extrapolation and a contrast check.
- OCR windows derived from the warp's intensity profiles (`crops.ts`) instead of fixed percentages; adaptive dark threshold for hazy phone exposure.
- Rotated collector-line second chance, number confidence with a weak-number guard, fuzzy set codes, OCR-tolerant name search (OR + stems, name column only), majority-set fallback.
- Scanner libraries can be self-hosted (`PUBLIC_SCANNER_ASSETS_URL` + `vendor-assets.mjs`), which makes the pipeline runnable offline and in CI.
- Headless scanner harness with synthetic fixtures (upload single/grid/sideways + live mode) — the first end-to-end verification of detection, OCR and matching outside a browser session.
- Upside-down retry (Phase 2b): sideways/upside-down cards that came out of the warp rotated 180° are recovered (synthetic sideways fixture 0/1 → 1/1).
- Live mode shows the final "Done! x of y identified." line like the upload modes.
- Foil-only printings show their foil price (marked) in `/cards`, reprints, wishlist and scan results instead of "-"; `/cards` price sort includes them.
- Card detail page flags EUR prices that contradict the USD price by more than 5× ("Check this price") — Cardmarket trend anomalies are visible instead of silently wrong.
- Upload scans run detection on a ≤1600 px copy and warp from the full-resolution photo (several seconds faster on phone photos).
- OpenCV load failures are surfaced in the live scanner (error + retry) instead of a silent dead preview; `loadOpenCV()` has a post-failure cooldown.
- Name OCR: crop ends before the mana cost; `bestNameMatch()` tolerates trailing OCR junk via prefix matching with a junk-word guard.
- CI runs the vitest suite.
- Live mode viewfinder follows the stream orientation; overlay mapping is letterbox-correct and DPR-aware (fixed the "scanner wants landscape" impression on phones).
- Time-based, card-size-relative scene stability (`SceneStabilizer`) replaces the frame-count/absolute-pixel version that never turned green on hand-held phones.
- Live captures skip the six-strategy detection and warp the tracked rectangles directly; Tesseract pool is pre-warmed in live mode.
- Stricter live detector filters (min area 3%, aspect 0.55–0.88, relative-area 25%) plus edge-cut and too-many-rects guards — keyboard keys are no longer captured as cards.
- Corner expansion is no longer clamped to the frame; name/collector crop windows widened so cards that fill the frame still OCR (fixed "0 of 1 identified" with the bottom crop showing flavour text).

### Known limitations

- **Live detection on dark, textured backgrounds (after the 2026-09-17 fix):** 4 of 76 synthetic mat frames still fail — dark lands and very dark cards whose outline and boxes all vanish against the mat — and 3 frames return a false rectangle. When only an inner block of a black card is visible to both passes (the "name bar + art" block, 0.83), it is still tracked as the card; inferring the card from such a block is not built. Several cards on a dark mat are untested: the coarse pass merges touching cards into blobs, and the blob rule only fires when the fine pass also saw the members.
- **Cards printed in another language.** The catalogue holds English names only (Scryfall's default-cards bulk), so a German, French … name bar never identifies a card by name — the footer (set, number, rarity, language code) and the artwork do. Scryfall's German images of seven ORI / BFZ cards hash 2–6 bits away from the English reference, so German phone captures land at 8–14 bits where English ones land at 0–10, and the 7–10-bit band needs a footer to confirm; a footer that loses the language code ("ORIDF" for "ORI DE") leaves the English name rules in charge. The printed names are in Scryfall's all-cards bulk (~2 GB, not imported); importing them would give foreign cards a name channel.
- **Art-hash coverage.** A printing is recognised (or excluded) by its artwork only when its hash exists. The table is complete on the dev PC (2026-09-17; 54 images Scryfall does not serve stay marked `'-'`), a database without it — the host until `npm run hash-art -- --import` ran, a fresh checkout — simply has no visual channel and behaves like Round 10. Cards added by later price updates have no hash until `npm run hash-art` runs again (seconds to minutes; nothing schedules it yet).
- **Same-artwork variants stay a footer problem.** MID vs Double Feature, regular vs extended/showcase frames of the same picture hash 0–8 bits apart; the artwork narrows a printing list only against clearly different pictures (16-bit gap). Small cards in phone spreads can hash more than 12 bits away from every reference (one Dawnhart Rejuvenator stays a `likely` of Dawnhart Geist), and foil glare shifts hashes too.
- **Open printings against the full catalogue** (25 of 104 on the eight photos): a confirmed identity whose footer is unreadable stays with a "Printing?" chip when the name has several printings — same-set variants (TMT #126 / #240, showcase frames), Innistrad: Double Feature reprints that carry the *same* collector number as MID / VOW (`010/277 C` matches both `mid#10` and `dbl#10`), The List, promos, basic lands. Only a legible set code (or the user) settles them; the majority set is deliberately not used to guess a printing.
- **Name-OCR ambiguity against the full catalogue** (9 `likely`, 9 misses on the eight photos): partial reads such as "Dawnhart r", "Escave" or "Moist wranger" have several plausible names; the fusion offers them for one tap instead of guessing. Phase 3 (art hash) is the planned answer, not more name rules.
- **Hold-out classes (2026-09-16, not tuned on):** Universes Beyond *flavor names* ("The Monstrous Serpent" for Koma, Cosmos Serpent; "Wild Rose Rebellion" for Counterspell) are unknown to the catalogue — the import needs Scryfall's `flavor_name` and the search a further alias; showcase footers (SOA, TLE) carry the collector number on the line *above* "SET • EN", outside the strip crop, so those printings stay open; a black-bordered card filling the frame on a dark cloth made every detection strategy return the image frame (fixed 2026-09-17 by the coarse fallback, see "Card Scanner Flow" step 2); old frames (Alliances, a numberless Tropical Island) defeat the name passes and have no collector line.
- **Server batch caps:** `/scan` answers at most 50 names per `printings` request and 100 per `lookups` / `near` request; the page chunks accordingly. A busy spread with three candidates per pass exceeded 50 and every name beyond the cut came back without printings ("confirmed", nothing to pick) until the chunking was added.
- **The catalogue's names are frozen at import.** `price-updater.ts` updates prices and inserts new cards but never rewrites `name` (or any other field) of an existing row; a Scryfall correction after the first import (a spoiler-season typo) stays in the database, and the scanner matches the stored spelling.
- On a spread whose cards all come out of the warp upside down, the upright name passes (incl. the PaddleOCR download and pass) run on junk before the rotated retry resolves the cards; ~10 s over the eight photos. Ordering the rotated gray pass before the upright PaddleOCR pass would remove most of it.
- PaddleOCR reads the two-line collector strip as nothing (the recognition model expects one line); a row-projection line split was tried in the experiment and did not work, so the footer stays Tesseract-only.
- `cropWindowsFromProfiles()` only finds a black border that starts at the warp edge; on a bright background the border begins after the expansion margin and the fixed windows are used instead (they fit the 5% expansion, so nothing is lost yet, but tight quads on bright tables would benefit from scanning for the first dark run).
- Filming a monitor instead of a physical card produces moiré and glare that degrade OCR; not a code issue.
- A card lying on its side comes out upside-down in the warp whenever its top points right (the short-edge rule in `orderCornersForCard()` breaks the 180° tie by proximity to the image origin); Phase 2b and the rotated collector-line pass recover most of them at the cost of a second OCR pass.
- Tesseract can't reliably distinguish the foil `★` from the bullet `•`, and nothing else reads it since the Google Vision retry was removed: text-based foil hints are never trusted, pixel-based detection runs in single-card mode only.
- Grid inference needs at least three detected cards on two rows and two columns; a single row or column of cards gets no synthetic cells, and cells are only offered one row/column beyond the detected extent.
- The detection worker loads its own OpenCV.js copy (from the browser cache after the page's own load); on a first visit that is a second ~10 MB parse, about a second on a laptop, during which the preview runs without outlines.
