# MTG Collector Design System

MTG Collector uses a dark, data-dense interface for collection and price tracking. The app should feel like a compact portfolio tool: quiet surfaces, clear numbers, fast scanning, and restrained MTG warmth.

## Tokens

Global tokens live in `src/app.css`.

- Background ladder: `--color-bg`, `--color-bg-elevated`, `--color-surface`, `--color-surface-raised`, `--color-surface-overlay`.
- Borders: use `--color-border` for most UI, `--color-border-subtle` for row dividers, and `--color-border-strong` for active/hover states.
- Text: `--color-text-strong` (titles, prices, figures), `--color-text` (body), `--color-text-muted` (labels, secondary lines), `--color-text-faint` (the quietest hints; `#808c9e`: 5.7:1 on `--color-bg` and 5.3:1 on `--color-surface`, where `#5d6878` reached 3.4:1 and 3.2:1; raised in the unslop review of 2026-11-02 so it passes AA).
- Actions: blue is primary (`--color-primary-button`), amber is accent (`--color-accent`).
- **Amber is rare.** It marks the chart lines, the active navigation item and the one key figure of a page (collection value on the dashboard, `/collection` and `/prices`, deck value, the period figure of `/market-value`). Every other price, total and number is `--color-text-strong`; a link hover goes to `--color-text` or `--color-text-strong`, never to amber (unslop review 2026-11-02: amber on every price made nothing stand out).
- Semantics: `--color-success`, `--color-danger`, `--color-warning`, `--color-info`. Use these tokens for every red, green and amber state (`text-[var(--color-danger)]`, `bg-[var(--color-success)]/10`, `border-[var(--color-warning)]/40`); never Tailwind's palette colours (`text-red-400`, `bg-green-600`). A confirming button is `btn-primary`, a destructive one `btn-danger`.
- MTG color identity: use original letter pips with `--pip-w`, `--pip-u`, `--pip-b`, `--pip-r`, `--pip-g`, `--pip-c`.
- Rarity: use dots/badges with `--rarity-common`, `--rarity-uncommon`, `--rarity-rare`, `--rarity-mythic`.
- Card frames (deck rows): `--frame-gold` (three or more colors) and `--frame-colorless` (grey); single colors and both halves of a two-color frame reuse the `--pip-*` tokens.

Numbers and prices should use the `tabular`, `numeric`, `price`, or `kpi-value` classes so columns do not visually drift. A `kpi-value` takes a colour or size utility (`text-[var(--color-accent)]` for the key figure, `text-[var(--color-success)]` for a gain): its own colour and size sit in `@layer components` so the utility wins.

Type: two weights only, 400 for text and 500 for headings, labels, buttons, chips and figures (`font-medium`); no 600–800 outside glyphs (the letters inside mana pips and legality icons stay heavy so they read at 0.6rem; the red "!" a deck rule names; the card names in `/scan` results, which stay `font-semibold` because the scanner harness finds them by `p.font-semibold`; the legal pages, whose text the owner reviews). Labels, table heads, chips and buttons are sentence case at 0.75rem without letter spacing ("Collection value", "Proxy", "Foil"); upper case is kept only for codes (`set-code`, the scan page's set input). Page titles say what the page is ("Collection", "Cards", "Price tracking"), without a kicker line above them.

Copy: no ellipsis in placeholders ("Search collection", "Card name"), no dashes as punctuation in visible text (owner rule), no exclamation marks in confirmations ("Added", "Copied").

Dates: `priceDate()` in `src/lib/utils.ts` writes every price date as "Oct 31, 2026" (UTC, before 10:00 UTC the day before, because Scryfall's bulk of the morning carries the previous day's prices). Do not format dates with `toLocaleDateString()` without a fixed locale.

Sizes: write text, spacing, image and layout sizes in `rem` (Tailwind's scale or `-[1.375rem]`), never `px`. The display size in `/settings` scales the root font size, so only rem grows with it; borders, shadows and radii may stay px (CLAUDE.md §5.8).

## Components And Classes

- `panel` and `panel-raised`: standard framed surfaces.
- `kpi-card`, `kpi-label`, `kpi-value`, `kpi-subtle`: compact stat tiles.
- `toolbar`: dense filter/search action rows.
- `btn`, `btn-primary`, `btn-danger`: reusable button styles. No lift or shadow on hover; the background and border change.
- `btn-on`: the chosen button of a row of `btn` toggles (sort buttons, list tabs, tag filters). Always with `aria-pressed` (or `aria-current` for a tab that is a link).
- `segmented`, `segmented-option`, `segmented-on`: one switch for two to five exclusive choices (chart views, display size, scan mode, catalogue sort). The track is `segmented` (add `flex gap-1` or a grid), each choice a `segmented-option` button with `aria-pressed`, the chosen one also `segmented-on`. These are the only two toggle styles; a third (filled amber, blue underline, ring) was removed on 2026-11-02.
- `control`: inputs and selects.
- `chip`, `set-code`, `foil-chip`: compact metadata. `foil-chip` ("Foil") is the one hue gradient the interface keeps, because it stands for the foil finish; every other surface is flat (no radial background wash, no glow on rarity dots, no gradient placeholders).
- `ManaCost.svelte`: renders original letter-based mana pips. Do not use emoji, Mana font, Keyrune, or official symbol art. A hybrid or Phyrexian symbol (`R/W`, `2/W`, `G/P`) drops the slash and splits its ring between the two colors (`mana-pip-hybrid`).
- `deck-card` with `frame-w|u|b|r|g|dual|multi|colorless`: a deck list row tinted in the card's color (a 4 px stripe, a tinted border and a fading background). One color tints the row; two colors split it half and half (`frame-dual`, `--frame-a` / `--frame-b` inline: a stripe in each color on the left and right, each half of the background in its color); three or more are gold; colorless cards, artifacts included, are grey. A land takes the colors of the mana it makes (its color identity), so a Mountain is red. Original tints only, never frame art. `cardFrame()` in `src/lib/deck.ts` picks the kind (owner rule 2026-10-29).
- `bracket-chip` (`DeckBracket.svelte`): the Commander Bracket after a deck's name ("Bracket 3 Upgraded", compact "B3" in lists).
- `ColorPips.svelte`: renders color identity pips.
- `card-shell` and `card-placeholder`: card result tiles with reserved image space. Hover lightens the border and background; nothing moves or scales.

Motion: transitions name their properties (`transition-[opacity,background-color,border-color]`), never `transition-all`, and nothing scales or lifts on hover or selection.

Keep cards, tables, and chart panels compact. Prefer typography, alignment, and subtle dividers over large decorative containers.

## IP And Fan Content

This app is an unofficial, free fan tool. Scryfall card images may remain because card images are part of the app's fan-content function. The footer disclaimer must stay visible:

"Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. Copyright Wizards of the Coast LLC."

Do not bake Wizards logos, official mana symbols, set symbols, Magic-branded fonts, Mana font, or Keyrune into the app chrome. Use original letter pips, text set codes, and neutral UI typography.

## Accessibility

Maintain visible focus rings, AA contrast on dark surfaces, keyboard-accessible menus and modals, reserved image aspect ratios, and reduced-motion support.
