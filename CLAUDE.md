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
- **Price history**: Deduplicated to one entry per day (`MAX(recorded_at) GROUP BY DATE(recorded_at)`)
- **Price snapshots**: Include both EUR and USD prices (`price_eur`, `price_eur_foil`, `price_usd`, `price_usd_foil`)

### Price Updates

Background job checks Scryfall `bulk-data` API for new data, downloads only when newer data exists. Runs 5s after server start (deferred to avoid SSR fetch warning). Snapshots prices only for cards in any user's collection. Manual trigger: `npm run import-cards` or POST to `/api/prices` (admin only).

## Directory Structure

```
src/
├── app.css                          # Dark theme, Tailwind imports
├── app.d.ts                         # App.Locals type (user, isAdmin)
├── hooks.server.ts                  # Auth middleware, DB init, price check, admin guard
├── lib/
│   ├── components/
│   │   └── CardPreview.svelte       # Hover zoom (portal to document.body)
│   ├── server/
│   │   ├── auth.ts                  # OAuth, sessions, user CRUD
│   │   ├── db.ts                    # SQLite setup, initDb(), migrations
│   │   ├── exchange-rate.ts         # USD→EUR rate (frankfurter.dev, 6h cache)
│   │   ├── images.ts                # Card image downloader
│   │   ├── price-updater.ts         # Scryfall bulk price updates
│   │   ├── schema.ts               # Drizzle ORM table definitions
│   │   └── seed.ts                  # Scryfall import script
│   ├── types.ts                     # Card, CardFace, CollectionCard, Tag, PriceHistoryEntry, SearchFilters + parseCardFromDb()
│   └── utils.ts                     # formatPrice, formatManaCost, conditionLabel, getColorName, getColorClass, getRarityColor, priceDate
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

1. User uploads photo → OpenCV detects card rectangles via **5 detection strategies**:
   - Canny edge detection with multiple thresholds (3 parameter sets)
   - Adaptive threshold segmentation (for tightly packed cards)
   - Histogram equalization + Canny (for low-contrast cards)
   - Otsu global threshold
   - Color saturation mask (for colored card borders)
2. Filters for 4-corner contours with MTG aspect ratio (0.5–0.9), IoU deduplication
3. Orientation detection: if top edge > left edge → card is sideways → rotate corners 90° clockwise
4. Perspective transform to 488×680 flat image
5. **Name OCR**: Tesseract.js on cropped name area → API search by name → FTS fallback
6. **Bottom OCR** (hybrid): If 5+ cards **and** the signed-in user has stored their own personal Google Vision API key in `/settings` → batch OCR via `/api/ocr` using that user's key; otherwise local Tesseract.js
7. **Foil detection** (dual): HSV color analysis on art area (saturation, hue/brightness variance) + text-based detection from separator char (`*` = foil, `.` = non-foil)
8. API search with fallbacks: set+number → name → FTS
9. Manual search fallback for unidentified cards
10. Select all / import all buttons for bulk adding (auth required)
11. **Copy for Moxfield**: generates text in `1 Name (SET) number` format, appends `*F*` for foils

### Price Change Indicator

Collection and prices pages show purchase price vs current price with color-coded percentage (green = up, red = down). When only USD price exists and purchase price is EUR, USD is converted to EUR for the calculation.

### Async Page Loading (Prices)

The `/prices` page loads its skeleton immediately (server only returns auth + price status), then fetches heavy data (stats, topCards, profitHistory) client-side via `/api/prices/data`. Animated skeleton placeholders are shown during loading.

### Profit/Loss Chart

Prices page shows profit/loss chart with 3 datasets: profit/loss (filled), purchase price (dashed), current value. Warning banner shown when cards are missing purchase prices.

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
- **OpenCV.js** — CDN loaded (`docs.opencv.org/4.9.0/opencv.js`), card rectangle detection + foil detection (HSV analysis)
- **Tesseract.js** — CDN loaded (`cdn.jsdelivr.net`), OCR fallback for collector numbers/names
- **Frankfurter API** (`api.frankfurter.dev/v1/latest`) — USD/EUR exchange rate, cached 6 hours
- **Plausible Analytics** (`analytics.mtg-collector.com`) — Self-hosted, cookieless reach measurement (Plausible Community Edition). Snippet embedded in `src/routes/+layout.svelte` inside `<svelte:head>`. Tracks pageviews, referrer, browser, OS, device type, and country — only aggregated stats, no personally identifiable raw data, no cookies. Domain is hardcoded in the served JS file, so no env vars are required.

## Database Migrations

New columns/tables are added via try/catch in `src/lib/server/db.ts:initDb()`:

```typescript
try {
  sqlite.exec('ALTER TABLE collection_cards ADD COLUMN user_id TEXT');
} catch { /* Column already exists */ }
```

This pattern allows the app to work with both fresh and existing databases.
