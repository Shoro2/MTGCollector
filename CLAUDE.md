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
npm run check                # TypeScript + Svelte validation
```

### Environment Variables (`.env`)

```
GOOGLE_CLIENT_ID=...         # Google OAuth credentials
GOOGLE_CLIENT_SECRET=...     # From console.cloud.google.com/apis/credentials
ORIGIN=http://localhost:5173 # App URL (used for OAuth callback)
```

Google OAuth redirect URI: `{ORIGIN}/auth/callback/google`

> **Google Vision API key**: Vision-based batch OCR is opt-in per user. There is no shared/server-wide key — each user can store their own personal API key in `users.google_vision_api_key` via the `/settings` page. Without a per-user key, the scanner uses local Tesseract.js only.

## Tech Stack

- **Framework**: SvelteKit 2 with Svelte 5 (runes enabled globally)
- **Database**: SQLite via better-sqlite3 + Drizzle ORM
- **Styling**: Tailwind CSS 4 with CSS custom properties (dark theme)
- **Auth**: Google OAuth 2.0 via `arctic` (PKCE flow)
- **Adapter**: `@sveltejs/adapter-node` for production
- **External**: Scryfall API, Google Cloud Vision API, OpenCV.js (CDN), Tesseract.js (CDN), Chart.js, Frankfurter API (exchange rates), Plausible Analytics (self-hosted)

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

**Tables**: `cards`, `card_faces`, `users`, `sessions`, `collection_cards`, `wishlist_cards`, `tags`, `collection_card_tags`, `price_history`, `api_usage`

**FTS5**: `cards_fts` virtual table for full-text search (name, type_line, oracle_text)

**Migrations**: Done via try/catch `ALTER TABLE ADD COLUMN` in `initDb()` — not via Drizzle migrations.

### Authentication

Google OAuth with session cookies:
1. `/auth/login/google` — generates state + PKCE verifier, redirects to Google
2. `/auth/callback/google` — validates, creates/updates user, sets session cookie
3. `hooks.server.ts` — validates session on every request, sets `locals.user`
4. Sessions expire after 30 days

**Public routes**: `/`, `/cards`, `/cards/[id]`, `/scan`, `/login`, `/auth/*`, `/impressum`, `/datenschutz`
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
│   │   ├── LiveScanner.svelte       # Camera viewfinder for /scan live mode (overlay, stability, auto-capture)
│   │   └── PriceTag.svelte          # List price with foil-only fallback + "Foil" chip (displayPrice)
│   ├── scanner/                     # Browser-side scanner library; pure modules are unit-tested (vitest)
│   │   ├── detect.ts                # detectCardsQuick(): fast Canny rectangle detector for the live preview
│   │   ├── stability.ts             # SceneStabilizer + sceneSignature(): time-based "scene holds still" logic
│   │   ├── geometry.ts              # orderCornersForCard(), fitContain(), touchesFrameEdge(), loadImage()
│   │   ├── opencv.ts                # Lazy OpenCV.js CDN loader
│   │   ├── tesseract.ts             # Tesseract.js worker pool (recognizeBatch, recognizeDetailed)
│   │   ├── parse.ts                 # parseCollectorInfo(): set code / collector number / foil hint
│   │   ├── similarity.ts            # Name similarity, OCR-junk heuristic, prefix-aware bestNameMatch()
│   │   ├── foil.ts                  # Pixel-based foil detection from the separator glyph
│   │   └── pipeline.ts              # disambiguateReprints()
│   ├── server/
│   │   ├── auth.ts                  # OAuth, sessions, user CRUD
│   │   ├── db.ts                    # SQLite setup, initDb(), migrations
│   │   ├── exchange-rate.ts         # USD→EUR rate (frankfurter.dev, 6h cache)
│   │   ├── images.ts                # Card image downloader
│   │   ├── price-updater.ts         # Scryfall bulk price updates
│   │   ├── schema.ts               # Drizzle ORM table definitions
│   │   └── seed.ts                  # Scryfall import script
│   ├── types.ts                     # Card, CardFace, CollectionCard, Tag, PriceHistoryEntry, SearchFilters + parseCardFromDb()
│   └── utils.ts                     # formatPrice, displayPrice, priceDivergence, formatManaCost, conditionLabel, getRarityColor, priceDate (+ utils.test.ts)
└── routes/
    ├── +layout.svelte               # Nav bar, footer (Impressum/Datenschutz)
    ├── +layout.server.ts            # Passes user to all pages via layout data
    ├── +page.svelte                 # Homepage with stats
    ├── admin/                       # Admin dashboard (users, DB stats, API usage) — admin only
    ├── api/
    │   ├── import/+server.ts        # Admin DB-init trigger
    │   ├── ocr/+server.ts           # Google Vision batch OCR endpoint
    │   └── prices/
    │       ├── +server.ts           # Price update trigger
    │       ├── card/+server.ts      # Single card price history API
    │       └── data/+server.ts      # Bulk prices data API (stats, topCards, profitHistory)
    ├── auth/                        # Google OAuth flow
    ├── cards/                       # Public card browser + detail pages
    ├── collection/                  # Collection CRUD, import, export, scan
    │   └── scan/                    # Collection-specific card scanner
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
| `/admin` | Admin dashboard — user management, DB statistics, API usage tracking (admin only) |
| `/collection/scan` | Collection-specific card scanner |
| `/api/prices/data` | Bulk prices data (stats, topCards, profitHistory, usdToEur) — used by `/prices` for async loading |
| `/api/ocr` | Google Vision batch OCR endpoint (TEXT_DETECTION, max 16 images) |
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
2. Filters for 4-corner contours with MTG aspect ratio (0.5–0.9), IoU deduplication
3. Corner ordering via `orderCornersForCard()`: the short edge becomes the top of the warp, so sideways cards come out upright without a separate rotation step
4. Corner expansion (~5% outward from the quad centre) + perspective transform to 488×680. The expansion is deliberately **not clamped** to the frame: `warpPerspective` pads out-of-frame samples with black, so a card that touches the image edge (typical for hand-held live captures) keeps the same ~3.5% margin as any other and the fixed crop windows below still line up. Clamping used to make such warps tight on the card and pushed the collector line out of its crop window.
5. **Name OCR**: Tesseract.js (PSM 7) on the name band — x 6–74%, y 5.5–13.5% of the warp (tall enough for both outer-border and inner-frame detections; ends before a three-symbol mana cost, which otherwise becomes junk letters glued to the name) → batched API search by name → FTS fallback. `bestNameMatch()` scores the whole OCR string and, when only trailing junk (mana symbols, frame edge: "…Bolt A SSSERRY") drags the score down, the matching word-prefix — but only if every remaining word looks like OCR junk (`looksLikeOcrJunk`), so "Fire Ball" never collapses to the card "Fire".
6. **Upside-down retry (Phase 2b)**: `orderCornersForCard()` cannot tell a card's top from its bottom when the card lies sideways or upside down (both short edges are geometrically identical), so about half of such cards leave the warp rotated 180° with garbage name OCR. Every card the name search didn't resolve is re-cropped from the 180°-rotated warp (`extractOcrCrops`, the same helper the main loop uses), OCR'd and searched again; on success the rotated crops replace the originals for the bottom-line phase. Costs one extra name-OCR pass for the failed cards only.
7. **Bottom OCR**: Tesseract.js (PSM 6) runs locally on every card's collector strip first (left half, y 89–99% of the warp; the collector line sits at ~96–99% of the physical card and lands between ~91% and ~98% of the warp depending on the detected quad's margin). If a card cannot be uniquely identified (status `not_found` or multiple unresolved reprints), and the signed-in user has stored their own personal Google Vision API key in `/settings` AND enabled the on-page retry toggle, those failed cards are batch-OCR'd via `/api/ocr` (max 16 per request) and re-matched.
8. **Foil detection**: text-based detection from the separator char between set code and language on the bottom line (`*` = foil, `.` = non-foil), parsed from the Tesseract bottom OCR.
9. API search with fallbacks: set+number → name → FTS
10. Manual search fallback for unidentified cards
11. Select all / import all buttons for bulk adding (auth required)
12. **Copy for Moxfield**: generates text in `1 Name (SET) number` format, appends `*F*` for foils
13. **Debug log**: Collapsible "Debugger" section shows timestamped log of every scan step (detection strategies, OCR text, similarity scores, set/number parsing, reprint disambiguation). Includes "Copy Log" button for sharing.

### Live Scanner (camera mode, `/scan` → "Live camera")

`src/lib/components/LiveScanner.svelte` streams the device camera and auto-captures when the scene holds still. Only `/scan` has this mode; `/collection/scan` is upload-only.

- **Viewfinder follows the stream.** The container's `aspect-ratio` is bound to `videoWidth / videoHeight` (updated on `loadedmetadata` and `resize`, so it tracks device rotation), capped at `70vh`. A phone held upright therefore gets a portrait preview. Previously the box was hard-wired to 16:9 and the overlay scaled x and y independently, which squashed an upright card into a landscape outline — the scanner looked as if it wanted the card in landscape.
- **Overlay mapping** goes through `fitContain()` (uniform scale + letterbox offset, same as CSS `object-fit: contain`) and renders at `devicePixelRatio`.
- **Per-frame detection** (`detectCardsQuick`, ~6 fps): the frame is drawn straight into a 720-px analysis canvas, Canny + `findContours`, then strict filters — min area 3% of the frame, bounding-box aspect 0.55–0.88 (an MTG card is 0.716), candidates below 25% of the largest survivor dropped. The strictness is intentional: the live loop auto-captures whatever it tracks, and the looser full-pipeline thresholds let keyboard keys and other small rectangles qualify as "cards".
- **Stability** (`SceneStabilizer`, pure + unit-tested): a rect is steady after 700 ms of continuous tracking with ≥3 detections and a centroid spread ≤5% of its long edge (floor 10 px). Time-based so slow phones don't wait longer than fast laptops; relative so hand jitter on a card filling the frame doesn't block forever. The "steady %" badge reaches 100% exactly when auto-capture becomes possible.
- **Guards:** a rect within 1.5% of the frame edge is drawn red ("card cut off at the edge") and blocks auto-capture; more than 12 tracked rects also block it ("too many rectangles"). Manual "Capture now" always works.
- **Capture hands the tracked rects to the pipeline.** `onCapture(canvas, rects)` → `processImage(canvas, presetRects)` builds the card candidates directly from them and skips the six full-resolution strategies (1–3 s on a phone). A manual capture while the scene is still moving passes no rects, so full detection runs as a fallback.
- **Pre-warming:** OpenCV.js loads *before* the camera is requested; if the CDN script fails, the component shows "Card detection unavailable" with a retry button instead of streaming a preview that can never detect anything. `loadOpenCV()` refuses re-attempts for 2 s after a failure (`force: true` for user-initiated retries) so no caller can re-inject the script tag several times a second. The Tesseract worker pool is created as soon as live mode is selected (`$effect` in `/scan`), so the first capture doesn't pay worker spawn + traineddata download on top of the OCR.
- **Re-arm:** `sceneSignature()` (centroids quantised to ~1/64 of the frame) prevents capturing the same layout twice; moving the cards out of frame and back re-arms.

### Price Change Indicator

Collection and prices pages show purchase price vs current price with color-coded percentage (green = up, red = down). When only USD price exists and purchase price is EUR, USD is converted to EUR for the calculation.

### Async Page Loading (Prices)

The `/prices` page loads its skeleton immediately (server only returns auth + price status), then fetches heavy data (stats, topCards, profitHistory) client-side via `/api/prices/data`. Animated skeleton placeholders are shown during loading.

### Profit/Loss Chart

Prices page shows profit/loss chart with 3 datasets: profit/loss (filled), purchase price (dashed), current value. Warning banner shown when cards are missing purchase prices.

## Testing

- `npm test` — vitest over `src/lib/**/*.test.ts` (Node environment, fully offline): collector-line parsing, name similarity + OCR-junk/prefix matching, reprint disambiguation, scene stability, overlay geometry, price display/divergence helpers. Anything touching OpenCV/Tesseract/DOM or SQLite is deliberately kept out of these modules or behind thin wrappers so the pure logic stays testable.
- `npm run check` — svelte-check (TypeScript + Svelte). CI runs `check`, `test` and `build` on every PR (`.github/workflows/ci.yml`).
- **Scanner harness** (`scripts/scanner-harness/`, see its README): drives the real `/scan` pipeline headlessly with Playwright — upload path (`harness.mjs --mode single|multiple photos/*.jpg`, optional `--expect` name lists per file, `--out` JSON with OCR texts and the full debug log) and live path (`live-harness.mjs` plays a Y4M clip as the fake camera). `make-synthetic.mjs` renders synthetic MTG-like cards (single, 2×2 grid, sideways) so the whole chain (detection → warp → crops → OCR → matching → reprint disambiguation) runs offline with the self-hosted libraries and a DB seeded by `seed-test-db.mjs`. Reference results on the sandbox: single 1/1 in ~3 s, grid 4/4 in ~4.4 s, sideways 1/1 in ~4 s (Phase 2b), live 2/2 about a second after the scene settles. Chromium's fake camera crops portrait clips when the app asks for 1920×1080, so render live scenes in landscape.
- Real-photo fixtures are still missing (photos supplied in chat did not arrive as files in the sandbox); `seed-cards.json` already contains the printings of the first batch so they can be run as soon as the files exist.

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

- **Scryfall API** (`api.scryfall.com`) — Card data, bulk downloads, price data. Rate limit: 200ms between image downloads.
- **Google OAuth** — User authentication (PKCE flow via `arctic`)
- **Google Cloud Vision API** (`vision.googleapis.com`) — Optional batch OCR (TEXT_DETECTION) for card scanning. Each user supplies their own personal API key in `/settings` (stored in `users.google_vision_api_key`). The server has no shared key. Usage is still tracked per user in the `api_usage` table.
- **OpenCV.js** — CDN loaded (`docs.opencv.org/4.9.0/opencv.js`) by default, card rectangle detection + foil detection (HSV analysis)
- **Tesseract.js** — CDN loaded (`cdn.jsdelivr.net`) by default, OCR for names and collector numbers
- **Self-hosting both** (`PUBLIC_SCANNER_ASSETS_URL`, see `src/lib/scanner/assets.ts`): `node scripts/scanner-harness/vendor-assets.mjs` fetches the same versions from npm (`@techstark/opencv-js@4.9.0-release.3`, `tesseract.js@5`, `@tesseract.js-data/eng`) into the gitignored `static/vendor/`; set the variable to `/vendor`. Needed for offline development and sandboxed CI, optional for production (no CDN calls, ~50 MB of static files). The CSP allows `connect-src data:` because OpenCV.js fetches its embedded WASM from a data: URL.
- **Frankfurter API** (`api.frankfurter.dev/v1/latest`) — USD/EUR exchange rate, cached 6 hours
- **Plausible Analytics** (`analytics.mtg-collector.com`) — Self-hosted, cookieless reach measurement (Plausible Community Edition). Snippet embedded in `src/routes/+layout.svelte` inside `<svelte:head>`. Tracks pageviews, referrer, browser, OS, device type, and country — only aggregated stats, no personally identifiable raw data, no cookies. Domain is hardcoded in the served JS file, so no env vars are required.

## Database Migrations

New columns/tables are added via `addColumnIfMissing` in `src/lib/server/db.ts:initDb()` (PRAGMA-checked so real ALTER errors propagate):

```typescript
addColumnIfMissing('collection_cards', 'user_id', 'TEXT REFERENCES users(id) ON DELETE CASCADE');
```

Structural migrations beyond column adds (e.g. the FTS5 external-content rebuild and the `price_history` same-day dedup + UNIQUE index) are done in dedicated helpers that are idempotent and run on every boot.

## Backups

The app's state is two files under `data/`:

- `data/mtg.db` — primary SQLite database (+ the transient `-wal`/`-shm` companions when the DB is open).
- `data/secret-key.hex` — AES-256 key used to encrypt per-user Google Vision API keys. Lose this file and existing users have to re-enter their key from `/settings`.

Recommended backup flow (safe while the app is running, because SQLite is in WAL mode):

```bash
# Consistent snapshot of the DB, even under load
sqlite3 data/mtg.db ".backup 'backups/mtg-$(date +%Y%m%d-%H%M%S).db'"
# And the secret key alongside it
cp data/secret-key.hex backups/secret-key-$(date +%Y%m%d-%H%M%S).hex
```

For Docker deployments, mount `/app/data` as a volume and include it in your host's backup job. `.backup` creates a consistent copy even while writers are active — prefer it over `cp mtg.db`, which can capture a torn page mid-write.

## Roadmap & Open Points

Status of the scanner work (most recent first). Keep this list current when you change the scanner.

### Done

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

### Next steps (in suggested order)

1. **Real-device verification** on Android Chrome and iOS Safari: portrait preview, auto-capture within ~1 s of holding still, red edge warning, a card filling the frame gets identified, upload scan of a 12 MP photo is noticeably faster. Tune `minStableMs` / `driftFrac` in `LiveScanner.svelte` if auto-capture fires too eagerly or too late.
2. **Price data quality (decision needed)**: when `priceDivergence()` flags an EUR value, collection value and profit/loss still use it. Options: (a) keep as is and only flag; (b) fall back to USD×rate for flagged printings in `/collection`, `/prices` and the homepage KPI; (c) let the user pin a manual price per printing. (b) changes reported totals based on a heuristic, so it should be an explicit product decision.
3. **Real-photo regression fixtures**: the harness and synthetic fixtures exist; what is missing are real phone photos (upload and live captures, incl. a card filling the frame, a 3×3 grid, sideways spreads, foils under glare) with expected name/set/number. Then wire `harness.mjs --expect` into CI with `vendor-assets.mjs` run in the job.
4. **Move `detectCardsQuick` into a Web Worker** (OpenCV.js loaded in the worker) so the ~50–100 ms per frame on phones stops blocking the main thread; the overlay would then stay smooth during detection.
5. **Sharpness gate before auto-capture** (variance of the Laplacian over the card ROI) to reject motion-blurred frames that pass the stability check.
6. **Derive crop windows from the warp itself** (locate the black border via row/column intensity profiles) instead of fixed percentages — would also make single-photo uploads robust to varying margins.
7. **Consolidate `/collection/scan` onto the shared pipeline**: it still has its own simpler detection (single Canny pass at full resolution, no name OCR, 92–100% bottom crop, 4× upscale) and none of the scanner fixes above. Its bottom crop is tolerant of tight warps, so it was left untouched rather than half-ported.
8. **Decide whether production should self-host the scanner libraries** (`PUBLIC_SCANNER_ASSETS_URL=/vendor`, ~50 MB static files, no CDN calls, Apache-2.0 licences with attribution). The mechanism exists; this is a deployment/privacy decision.

### Known limitations

- Filming a monitor instead of a physical card produces moiré and glare that degrade OCR; not a code issue.
- A card lying on its side can come out upside-down in the warp (the short-edge rule in `orderCornersForCard()` breaks the 180° tie by proximity to the image origin). Upright cards are unaffected.
- Tesseract can't reliably distinguish the foil `★` from the bullet `•`; text-based foil hints are only trusted from Google Vision, pixel-based detection runs in single-card mode only.
- The live detector runs on the main thread; on low-end phones the preview can stutter while a frame is analysed.
