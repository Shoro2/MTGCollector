# CLAUDE.md - MTG Collector

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

## Tech Stack

- **Framework**: SvelteKit 2 with Svelte 5 (runes enabled globally)
- **Database**: SQLite via better-sqlite3 + Drizzle ORM
- **Styling**: Tailwind CSS 4 with CSS custom properties (dark theme)
- **Auth**: Google OAuth 2.0 via `arctic` (PKCE flow)
- **Adapter**: `@sveltejs/adapter-node` for production
- **External**: Scryfall API, OpenCV.js (CDN), Tesseract.js (CDN), Chart.js, Frankfurter API (exchange rates)

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

**Tables**: `cards`, `card_faces`, `users`, `sessions`, `collection_cards`, `wishlist_cards`, `tags`, `collection_card_tags`, `price_history`

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

### Multi-User Collections

All `collection_cards` and `wishlist_cards` queries filter by `user_id`. Each user has an isolated collection and wishlist. The `user_id` column is nullable for backward compatibility with pre-auth databases.

### Price System

- **EUR primary, USD fallback**: Prices display in EUR when available, otherwise USD with `$` prefix
- **USD→EUR conversion**: For profit/loss calculations, USD prices are converted using a live exchange rate from `frankfurter.dev` (cached 6 hours, fallback 0.92). See `src/lib/server/exchange-rate.ts`
- **Price history**: Deduplicated to one entry per day (`MAX(recorded_at) GROUP BY DATE(recorded_at)`)
- **Price snapshots**: Include both EUR and USD prices (`price_eur`, `price_eur_foil`, `price_usd`, `price_usd_foil`)

### Price Updates

Background job checks Scryfall `bulk-data` API for new data, downloads only when newer data exists. Runs 5s after server start (deferred to avoid SSR fetch warning). Snapshots prices only for cards in any user's collection. Manual trigger: `npm run import-cards` or POST to `/api/prices`.

## Directory Structure

```
src/
├── app.css                          # Dark theme, Tailwind imports
├── app.d.ts                         # App.Locals type (user)
├── hooks.server.ts                  # Auth middleware, DB init, price check
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
│   ├── types.ts                     # Card, CollectionCard, Tag interfaces
│   └── utils.ts                     # formatPrice, formatManaCost, conditionLabel
└── routes/
    ├── +layout.svelte               # Nav bar, footer (Impressum/Datenschutz)
    ├── +page.svelte                 # Homepage with stats
    ├── api/
    │   └── prices/
    │       ├── +server.ts           # Price update trigger
    │       └── card/+server.ts      # Single card price history API
    ├── auth/                        # Google OAuth flow
    ├── cards/                       # Public card browser + detail pages
    ├── collection/                  # Collection CRUD, import, export
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
| `/prices` | Collection value over time (Chart.js), profit/loss chart toggle, top cards with per-card price history popup |

## Important Patterns

### CardPreview (Portal Pattern)

`CardPreview.svelte` renders a hover preview by creating a `<div>` directly in `document.body`. This avoids CSS `transform` creating a containing block that clips `position: fixed` elements.

### Card Scanner Flow

1. User uploads photo → OpenCV detects card rectangles via Canny edge + contour detection
2. Filters for 4-corner contours with MTG aspect ratio (0.5–0.9)
3. Orientation detection: if top edge > left edge → card is sideways → rotate corners 90° clockwise
4. Perspective transform to 488×680 flat image
5. **Foil detection**: HSV color analysis on art area — checks saturation, hue variance (rainbow effect), brightness variance (specular highlights). Scoring: ≥4 of 8 indicators = foil
6. Crop bottom 8% → scale 4× → Tesseract OCR for set code + collector number
7. API search with fallbacks: set+number → name → FTS
8. Manual search fallback for unidentified cards
9. Select all / import all buttons for bulk adding (auth required)
10. **Copy for Moxfield**: generates text in `1 Name (SET) number` format, appends `*F*` for foils

### Price Change Indicator

Collection and prices pages show purchase price vs current price with color-coded percentage (green = up, red = down). When only USD price exists and purchase price is EUR, USD is converted to EUR for the calculation.

### Profit/Loss Chart

Prices page offers a toggle between "Value" and "Profit/Loss" charts. Profit chart shows 3 datasets: profit/loss (filled), purchase price (dashed), current value. Warning banner shown when cards are missing purchase prices.

## Coding Conventions

- **No stores** — all data flows from `+page.server.ts` load functions
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
- **OpenCV.js** — CDN loaded (`docs.opencv.org/4.9.0/opencv.js`), card rectangle detection + foil detection (HSV analysis)
- **Tesseract.js** — CDN loaded (`cdn.jsdelivr.net`), OCR for collector numbers
- **Frankfurter API** (`api.frankfurter.dev`) — USD/EUR exchange rate, cached 6 hours

## Database Migrations

New columns/tables are added via try/catch in `src/lib/server/db.ts:initDb()`:

```typescript
try {
  sqlite.exec('ALTER TABLE collection_cards ADD COLUMN user_id TEXT');
} catch { /* Column already exists */ }
```

This pattern allows the app to work with both fresh and existing databases.
