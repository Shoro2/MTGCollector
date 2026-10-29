# MTG Collector Design System

MTG Collector uses a dark, data-dense interface for collection and price tracking. The app should feel like a compact portfolio tool: quiet surfaces, clear numbers, fast scanning, and restrained MTG warmth.

## Tokens

Global tokens live in `src/app.css`.

- Background ladder: `--color-bg`, `--color-bg-elevated`, `--color-surface`, `--color-surface-raised`, `--color-surface-overlay`.
- Borders: use `--color-border` for most UI, `--color-border-subtle` for row dividers, and `--color-border-strong` for active/hover states.
- Text: `--color-text`, `--color-text-strong`, `--color-text-muted`, `--color-text-faint`.
- Actions: blue is primary (`--color-primary-button`), amber is accent (`--color-accent`).
- Semantics: `--color-success`, `--color-danger`, `--color-warning`, `--color-info`.
- MTG color identity: use original letter pips with `--pip-w`, `--pip-u`, `--pip-b`, `--pip-r`, `--pip-g`, `--pip-c`.
- Rarity: use dots/badges with `--rarity-common`, `--rarity-uncommon`, `--rarity-rare`, `--rarity-mythic`.
- Card frames (deck rows): `--frame-gold` (three or more colors) and `--frame-colorless` (grey); single colors and both halves of a two-color frame reuse the `--pip-*` tokens.

Numbers and prices should use the `tabular`, `numeric`, `price`, or `kpi-value` classes so columns do not visually drift.

## Components And Classes

- `panel` and `panel-raised`: standard framed surfaces.
- `kpi-card`, `kpi-label`, `kpi-value`, `kpi-subtle`: compact stat tiles.
- `toolbar`: dense filter/search action rows.
- `btn`, `btn-primary`, `btn-danger`: reusable button styles.
- `control`: inputs and selects.
- `chip`, `set-code`, `foil-chip`: compact metadata.
- `ManaCost.svelte`: renders original letter-based mana pips. Do not use emoji, Mana font, Keyrune, or official symbol art. A hybrid or Phyrexian symbol (`R/W`, `2/W`, `G/P`) drops the slash and splits its ring between the two colors (`mana-pip-hybrid`).
- `deck-card` with `frame-w|u|b|r|g|dual|multi|colorless`: a deck list row tinted in the card's color (a 4 px stripe, a tinted border and a fading background). One color tints the row; two colors split it half and half (`frame-dual`, `--frame-a` / `--frame-b` inline: a stripe in each color on the left and right, each half of the background in its color); three or more are gold; colorless cards, artifacts included, are grey. A land takes the colors of the mana it makes (its color identity), so a Mountain is red. Original tints only, never frame art. `cardFrame()` in `src/lib/deck.ts` picks the kind (owner rule 2026-10-29).
- `bracket-chip` (`DeckBracket.svelte`): the Commander Bracket after a deck's name ("Bracket 3 Upgraded", compact "B3" in lists).
- `ColorPips.svelte`: renders color identity pips.
- `card-shell` and `card-placeholder`: card result tiles with reserved image space.

Keep cards, tables, and chart panels compact. Prefer typography, alignment, and subtle dividers over large decorative containers.

## IP And Fan Content

This app is an unofficial, free fan tool. Scryfall card images may remain because card images are part of the app's fan-content function. The footer disclaimer must stay visible:

"Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. Copyright Wizards of the Coast LLC."

Do not bake Wizards logos, official mana symbols, set symbols, Magic-branded fonts, Mana font, or Keyrune into the app chrome. Use original letter pips, text set codes, and neutral UI typography.

## Accessibility

Maintain visible focus rings, AA contrast on dark surfaces, keyboard-accessible menus and modals, reserved image aspect ratios, and reduced-motion support.
