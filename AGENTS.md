# AGENTS.md - MTG Collector

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
2. Filters for 4-corner contours with MTG aspect ratio (0.5–0.9), IoU deduplication, containment and size filters. **Multiple mode** adds spread-aware steps: a dimension-consistency filter (bounding boxes more than 15% off the median width/height are partial cards or two touching cards merged into one blob and are dropped), then grid inference fills every empty cell of the detected row/column grid, extrapolates one row/column beyond the detected extent at the median pitch, and keeps only cells with texture (grey-level std ≥ 20, so blank paper is ignored). Touching sideways cards in a phone photo went from 6/10 and 12/15 detected to 10/10 and 15/15.
3. Corner ordering via `orderCornersForCard()`: the short edge becomes the top of the warp, so sideways cards come out upright without a separate rotation step
4. Corner expansion (~5% outward from the quad centre) + perspective transform to the base size 488×680, or up to 2× that when the quad covers more source pixels (`WARP_MAX_SCALE`: camera photos, a card filling a live frame), so the ~1.5 mm collector line keeps its native pixels instead of being downsampled before OCR. Result thumbnails stay at base size (`cardThumbnailUrl`). The expansion is deliberately **not clamped** to the frame: `warpPerspective` pads out-of-frame samples with black, so a card that touches the image edge (typical for hand-held live captures) keeps the same ~3.5% margin as any other and the fixed crop windows below still line up. Clamping used to make such warps tight on the card and pushed the collector line out of its crop window.
5. **OCR windows from the warp itself** (`src/lib/scanner/crops.ts`): row/column mean-intensity profiles of the warped card locate the inner edges of the black border (leading/trailing dark runs with a per-profile adaptive threshold, 40% of the 5th→95th percentile range); the name band starts just below the top edge (8.5% tall) and the collector window just above the bottom edge (8% tall, covers the border). Loose, tight and grid-inferred warps therefore all read the right rows. Cards without a dark border (white-bordered, some showcase frames) fall back to the fixed windows (name x 6–74%, y 5.5–13.5%; collector strip left half, y 89–99%).
6. **Name OCR**: Tesseract.js (PSM 7) on the name band, upscaled to 1.5× the base warp (`NAME_OCR_SCALE`) so the letters land in Tesseract's ~30–50 px sweet spot — the old 6× crops produced ~140 px letters and made the line finder return nothing for perfectly legible names → batched API search by name. `searchByName()` tries exact → FTS prefix on all words → LIKE → **OCR-tolerant fallbacks restricted to the name column**: any word (OR), then word stems (first 4 letters of 5+-letter words). Junk glued to a name ("Nobody ol") and single misread letters ("Tendcrize", "Comesiibisl") still reach the right candidates; the client ranks by similarity and applies the 0.6 threshold. `bestNameMatch()` scores the whole OCR string and, when only trailing junk (mana symbols, frame edge: "…Bolt A SSSERRY") drags the score down, the matching word-prefix — but only if every remaining word looks like OCR junk (`looksLikeOcrJunk`), so "Fire Ball" never collapses to the card "Fire". Cards still unresolved get a **raw-line pass (Phase 2a)**: PSM 13 on a 2× crop (`NAME_OCR_SCALE_ALT`) reads a different subset of name bars (measured on 75 real-photo cards: 41 names read at 6×, 51 at 1.5×, 58 with the raw-line pass; `scripts/scanner-harness/ocr-scale-experiment.mjs`). Unaccepted candidates (score < 0.6) are kept as `nameBest` — positive evidence of what the name OCR says.
7. **Upside-down retry (Phase 2b)**: `orderCornersForCard()` cannot tell a card's top from its bottom when the card lies sideways or upside down (both short edges are geometrically identical): for a spread rotated one way *every* card leaves the warp rotated 180°. Every card the name search didn't resolve is re-cropped from the 180°-rotated warp (`extractOcrCrops`, the same helper the main loop uses), OCR'd (single-line, then raw-line pass) and searched again; on success the rotated crops replace the originals. Cards still unresolved keep the rotated crops as `altNameUrl/altBottomUrl/altCroppedUrl` (+ `*2` variants) for the next phase.
8. **Bottom OCR**: Tesseract.js (PSM 6) runs locally on every card's collector strip at 4× the base warp (`BOTTOM_OCR_SCALE`; 18 of 75 strips read at the old 6×, 24 at 4×, 27 with a second 2× pass); for still-unresolved cards the 2× strip (`BOTTOM_OCR_SCALE_ALT`) and **both orientations** are OCR'd and the variant that parses best as a collector line wins (an unreadable name no longer wastes a legible "C 0156 TMT EN" on the other side). `parseCollectorInfo()` reports a `numberSource` (fraction / number-total pair / rarity-prefixed / weak) plus the rarity letter printed next to the number; a fraction whose numerator is shorter than its total ("4/277" for 040/277) or a rarity-prefixed number with fewer than three digits lost a digit and is downgraded to weak. **Plausibility of number-only hits** (`numberOnlyHitPlausible`, tuned against the distractor DB described in the harness README): a weak number needs name evidence (no readable word → rejected, readable words that contradict → rejected); a full-length number is rejected only when the name search positively points at a different card (`nameBest` ≥ 0.45 while the hit scores < 0.3), so a stray fake word cannot veto a good read; a rarity letter that contradicts the hit's rarity rejects it (basic lands print L). This turned the two wrong cards of the eight test photos into "not found" at the cost of one correct weak-number guess. `searchBySetNumber()` corrects a set code one substitution away (IMT/THT → TMT) when the code is unknown and exactly one neighbour has that number. **Majority-set fallback (Phase 3c)**: the cards in one photo usually share a set; a reliable number without a readable set code is looked up in the set most identified cards belong to and accepted only if the hit's name agrees with the partial name OCR (similarity ≥ 0.4) and its rarity does not contradict the printed letter. Bottom OCR continues (left half, y 89–99% of the warp; the collector line sits at ~96–99% of the physical card and lands between ~91% and ~98% of the warp depending on the detected quad's margin). If a card cannot be uniquely identified (status `not_found` or multiple unresolved reprints), and the signed-in user has stored their own personal Google Vision API key in `/settings` AND enabled the on-page retry toggle, those failed cards are batch-OCR'd via `/api/ocr` (max 16 per request) and re-matched.
9. **Foil detection**: text-based detection from the separator char between set code and language on the bottom line (`*` = foil, `.` = non-foil), parsed from the Tesseract bottom OCR.
10. API search with fallbacks: set+number → name → FTS
11. Manual search fallback for unidentified cards
12. Select all / import all buttons for bulk adding (auth required)
13. **Copy for Moxfield**: generates text in `1 Name (SET) number` format, appends `*F*` for foils
14. **Debug log**: Collapsible "Debugger" section shows timestamped log of every scan step (detection strategies, OCR text, similarity scores, set/number parsing, reprint disambiguation). Includes "Copy Log" button for sharing.

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
- **Real photos**: eight phone/camera spreads (2x2 … 3x5, upright and sideways, touching cards, foils, EXIF-rotated) were run through the harness during development: 87 of 104 cards identified, none wrong, against a DB seeded with distractor printings at every plausible digit misread (`seed-test-db.mjs --distractors`, so a misread number shows up as WRONG like it would in production). Results per photo and the remaining failure classes are in `scripts/scanner-harness/README.md`. The photos are not in the repository (2–6 MB each); `expectations-real-photos.json` and `seed-cards.json` let them be re-run from a local folder. `dump-debug.mjs` writes the detection overlay and every card's crops as a montage — the fastest way to see *why* a card failed.

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

Keep this section current when you change the scanner. It has three parts: the improvement programme (the plan), the history of what is done, and known limitations.

### Scanner improvement programme (planned 2026-09-16)

**Basis.** Eight real photos run through the harness: 87 of 104 names identified, 0 wrong, measured against the distractor DB — but *in-sample* (OCR scales and plausibility rules were tuned on these photos) and *name-level only*. An external code review of commit 9cfe928 (16 Sept 2026, not in the repository) reproduced four defects with the real modules and set an acceptance definition; its six regression tests fail 5/6 on the current code. Both sources are merged into the programme below.

**Findings that drive the order** (all reproduced):

- The harness scores a bag of names; the printing is not checked (Bot Bashing Time is the PTMT #85p promo in the photos, a TMT #85 hit counts as correct) and nothing fails the run.
- `disambiguateReprints()` matches arbitrary digit sequences before the exact set+number: `C 0085p PTMT EN` with set `ptmt`/number `85p` returns `tmt#85`; a copyright year `2009` selects a printing numbered 2009.
- Double-faced cards: production stores Scryfall's canonical name (`Beloved Beggar // Generous Soul`), the search and `bestNameMatch()` ignore `card_faces`, so a *perfect* read of the front face scores 0.50/0.44 and fails the 0.6 threshold. The harness seed uses simplified names and hides this. Name queries are also capped at the 10 newest printings (exact) / 20 rows, so the right printing of a much-reprinted card may not be among the candidates.
- `found` does not mean "printing confirmed": unresolved reprint lists are `found`, and "Import all" writes `results[0]` (the newest printing) into the collection; the Tesseract path stores finish `nonfoil` although it has no evidence.
- Local scanner findings still open: strip-score ties keep the first reading, extra strips only run for cards without any name candidate, the Vision retry only sees the footer crop, `cropWindowsFromProfiles()` fails on bright backgrounds, 7 of the 17 misses are ~12 px collector digits (15 cards per phone photo).

**Target architecture** (evidence channels feed one decision):

```
photo / live frame -> EXIF-normalised -> detection (quads, orientation, quality)
  -> warp per card at native resolution
  -> evidence channels, in parallel:
       name OCR (single-line + raw-line, face-aware search)   -> identity candidates + scores
       footer OCR (4x, 2x, both orientations, Vision)         -> set / number / rarity / language / finish readings
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

#### Phase 0 — Measurement foundation (~4 h)

- **WP0.1 Printing-level harness metric.** `expectations-real-photos.json` lists expected printings (`name`, `set`, `number`, optional `finish`) per photo; `harness.mjs` reports the metrics above, compares against a committed `baseline.json` and exits non-zero on any regression. Acceptance: the PTMT #85p promo returned as TMT #85 counts as a wrong printing; a missing card is a miss even when it is correctly `unknown`.
- **WP0.2 Reference-data fidelity.** Harness seed from canonical data: names with ` // `, `card_faces` rows, real layouts; `seed-cards.json` regenerated from a full DB export (`export-seed.mjs`) instead of hand-typed rows; distractors extended cross-set (the same number in every other seeded set, so a misread set code like `YOW` for `MID` shows up as WRONG); `photo-inventory.json` (hashes, sizes, instance counts) committed.
- **WP0.3 Review regression tests.** Add the six tests as `src/lib/scanner/review-regressions.test.ts`, the five failing ones as `it.fails` until WP1.1/WP1.2 land, then flip them.
- **WP0.4 Hold-out photos (owner).** 5–10 new photos not used for tuning: double-faced cards, showcase/borderless frames, foils under glare, a 2×3 phone spread, single-card live captures, a mixed-set pile, an empty table (negative case). Expected printings verified by the owner.

#### Phase 1 — Matching correctness (~12 h)

- **WP1.1 Reprint disambiguation order** (`pipeline.ts`): exact set + full collector number first (suffix preserved, only leading zeros normalised), then unique set, then unique number — and a number only when it comes from a structural parse (fraction, rarity-prefixed, pair; never an arbitrary digit sequence, never a copyright year). Acceptance: the four review tests pass; conflicting evidence yields `null`, not a guess.
- **WP1.2 Face-aware names.** `bestNameMatch()` scores the canonical name and each face (split on ` // `) and returns the canonical name; `searchByName()` matches face names (join `card_faces`, `name LIKE 'q //%'`); scan results show the visible face; the seed uses canonical names (WP0.2). Acceptance: the two DFC review tests pass; DSC00855's DFCs resolve by name against the canonical seed.
- **WP1.3 Identity-first candidate search.** Name queries return distinct identities (top 20 by relevance, all fallbacks), then *all printings* of an accepted identity (`oracle_id`, no date limit) for reprint resolution; inner-substring fallback for words with a glued or misread first letter (`CTenderize`, `Jrenderize` → Tenderize).
- **WP1.4 Evidence fusion module** `src/lib/scanner/resolve.ts` (pure, unit-tested; replaces the inline logic in `applyBottomMatch`, the weak-number guard, the majority-set fallback and `numberOnlyHitPlausible`). Inputs: name candidates with scores from every pass, footer readings from every variant (set, number, number source, rarity, language, foil hint), the majority set, printings per candidate. Rules: readings that agree across variants outrank a single reading; strong number + set + rarity agreement → printing *confirmed*; name ≥ 0.6 with a unique printing → *confirmed*; name ≥ 0.4 ∩ number within one edit or a dropped digit ∩ read or majority set → unique → *likely*; strong name and strong number that disagree → *conflict*, never silently one of them; weak number without name evidence → *unknown* with the candidate attached. Acceptance: distractor DB stays at 0 wrong; Dawnhart Rejuvenator, The Last Ronin's Technique and Null Group become `likely` or `confirmed`.
- **WP1.5 Result states in the UI and import.** Four states rendered distinctly; `likely` has a one-tap "Accept" with the printing prefilled; `unknown` opens the manual search prefilled with the best candidate; `conflict` shows both readings. "Select all", "Import all" and the Moxfield text take confirmed + user-accepted cards only; an unresolved reprint list is never imported via index 0.
- **WP1.6 Finish and language as fields.** Scan result gets `finish: 'nonfoil' | 'foil' | 'etched' | 'unknown'` and `language`; the Tesseract path yields `unknown` (badge "Finish?"); `*F*` in the Moxfield text only for confirmed foil; accepting a row confirms its finish. The collection schema change is WP5.4.

#### Phase 2 — OCR evidence quality (~8 h)

- **WP2.1 Keep every footer reading** (4×, 2×, rotated, Vision) as evidence for WP1.4 instead of a single strip-score winner.
- **WP2.2 Extra strips for name-known cards** whose printing is unresolved (today only cards without a name candidate get them).
- **WP2.3 Name-band preprocessing variants** (Otsu binarisation, inversion for light-on-dark frames, CLAHE) as a third pass for unresolved cards, measured first with `ocr-scale-experiment.mjs --preprocess`. Target: the Skaab Wrangler class (legible crop, Tesseract fails at every scale).
- **WP2.4 Text-line localisation fallback.** When the profile/fixed windows yield no text, find the name bar and the collector line by edge-density projection over the top 25 % / bottom 15 % of the warp; the profile windows stay the fast path.
- **WP2.5 Vision retry input:** name crop + footer crop (optionally the base-size warp) per failed card; results feed the fusion like any other reading; still only with the user's own key and the on-page toggle.
- **WP2.6 Second OCR engine evaluation** (PP-OCRv5 via ONNX Runtime Web): same crops, same experiment script; adopt only with a measured gain and no new wrong identifications; ~10–15 MB model, WASM/WebGPU. Evaluation only; adoption is a separate decision.

#### Phase 3 — Visual reference matching (~3–5 days)

- **WP3.1 Art hash index (server).** A job computes a 64-bit DCT perceptual hash of the art region of every printing's image (fixed art box for standard frames, whole card for showcase/borderless/full-art), stored in `cards.art_hash` and served as a compact table (~1 MB gzipped, cached). Images come from Scryfall with the existing rate limit (~100k images, hours, once; the `unique_artwork` list halves it); decoding needs `sharp` (new dependency). Disk and time budget are an owner decision.
- **WP3.2 Client hash lookup.** Hash of the warped card's art region (plain canvas DCT, no OpenCV needed), Hamming search (≤ 10 bits) over the table → identity candidates with distances → fusion evidence. Same artwork gives the same hash: this decides *identity*, the footer decides the *printing*.
- **WP3.3 Feature verification for the top-K candidates** (ORB/AKAZE + RANSAC homography): the vendored OpenCV.js 4.9 build exposes no features2d symbols, so this needs a custom build or a server-side verifier; optional, the hash alone should carry identity for most cards.
- Acceptance: identity ≥ 100/104 on the eight photos with 0 wrong identities; the hold-out set reported separately; printing rules unchanged.

#### Phase 4 — Live scanner and robustness (~2 days)

- **WP4.1 Best-frame selection:** keep the last N frames while the scene is stable, score sharpness (Laplacian variance over the card ROI) and glare (saturated-pixel fraction), capture the best one; show "blur"/"glare" hints in the viewfinder.
- **WP4.2 `detectCardsQuick` in a Web Worker** (OpenCV.js in the worker, ImageBitmap transfer) so the preview stays smooth on phones.
- **WP4.3 Grid inference as a hypothesis:** oriented edge lengths instead of the axis-aligned ±15 % median filter, evidence required per cell (kept), no fill to an expected count, perspective-tolerant checks.
- **WP4.4 Real-device verification (owner):** Android Chrome and iOS Safari checklist — portrait preview, auto-capture within ~1 s, red edge warning, a card filling the frame identified, 12 MP upload noticeably faster; tune `minStableMs`/`driftFrac` if needed.
- **WP4.5 `/collection/scan`** consolidated onto the shared pipeline or retired in favour of `/scan` + add-to-collection.

#### Phase 5 — Architecture and CI (~1.5 days)

- **WP5.1 Orchestrator extraction:** phases, evidence collection and fusion move from the Svelte page into `src/lib/scanner/orchestrator.ts` (testable, the page only renders); OCR parameters passed per batch (`recognizeBatch(pool, urls, { psm, whitelist })`) so concurrent scans never share mutable worker state.
- **WP5.2 Harness in CI:** vendored assets job, photos from Git LFS or a fixtures bucket, baseline comparison, hold-out reported separately.
- **WP5.3 Frozen references:** reference-data snapshot, library versions and photo hashes recorded with every baseline (with WP0.2).
- **WP5.4 Collection schema:** `collection_cards.finish` (nonfoil/foil/etched/unknown) and `language`, the `foil` boolean kept in sync; import, export and UI updated.

**Order and dependencies.** 0 → 1 → 2 → 3 in sequence (each measured before the next); 4 and 5 can interleave with 2 and 3. WP1.4 precedes WP2.1; WP5.1 is best done before Phase 3 so the visual channel lands in a clean fusion.

**Expected outcome on the eight photos** (in-sample; the hold-out set is the real check):

| After | Identity | Printing | Wrong |
|---|---|---|---|
| today | 87/104 | not measured | 0 (names) |
| Phase 0 | 87 | measured (promo case counts as wrong) | measured at printing level |
| Phase 1 | 90–93 | identity minus genuine ambiguities | 0, DFC path works in production |
| Phase 2 | 93–96 | as above | 0 |
| Phase 3 | ≥ 100 | ~95 (footer still needed for reprints) | 0 |
| Phases 4–5 | unchanged on stills; live quality, CI, schema | | |

**Decisions needed from the owner:** hold-out photos (WP0.4); the visual index data volume (once ~100k Scryfall images, several GB and hours on the server); a second OCR engine only after WP2.6 numbers; and the two standing decisions below (price data quality, self-hosting the scanner libraries).

**Standing decisions (unchanged):**

- **Price data quality**: when `priceDivergence()` flags an EUR value, collection value and profit/loss still use it. Options: (a) keep as is and only flag; (b) fall back to USD×rate for flagged printings in `/collection`, `/prices` and the homepage KPI; (c) let the user pin a manual price per printing. (b) changes reported totals based on a heuristic, so it should be an explicit product decision.
- **Self-hosting the scanner libraries in production** (`PUBLIC_SCANNER_ASSETS_URL=/vendor`, ~50 MB static files, no CDN calls, Apache-2.0 licences with attribution). The mechanism exists; this is a deployment/privacy decision.

### Done

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

- `cropWindowsFromProfiles()` only finds a black border that starts at the warp edge; on a bright background the border begins after the expansion margin and the fixed windows are used instead (they fit the 5% expansion, so nothing is lost yet, but tight quads on bright tables would benefit from scanning for the first dark run).
- Filming a monitor instead of a physical card produces moiré and glare that degrade OCR; not a code issue.
- A card lying on its side comes out upside-down in the warp whenever its top points right (the short-edge rule in `orderCornersForCard()` breaks the 180° tie by proximity to the image origin); Phase 2b and the rotated collector-line pass recover most of them at the cost of a second OCR pass.
- Tesseract can't reliably distinguish the foil `★` from the bullet `•`; text-based foil hints are only trusted from Google Vision, pixel-based detection runs in single-card mode only.
- The live detector runs on the main thread; on low-end phones the preview can stutter while a frame is analysed.
