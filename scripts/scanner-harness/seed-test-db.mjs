// Seed data/mtg.db with the printings listed in seed-cards.json so the scanner
// harness can identify cards without a full Scryfall import. The schema must
// exist already: start the dev server once (it runs initDb on the first
// request), then run this script from the repository root.
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
const db = new Database('data/mtg.db');
const cards = JSON.parse(readFileSync(new URL('./seed-cards.json', import.meta.url), 'utf8'));
const ins = db.prepare(`INSERT OR REPLACE INTO cards (id, oracle_id, name, mana_cost, cmc, type_line, oracle_text, colors, color_identity, keywords,
	set_code, set_name, collector_number, rarity, image_uri, layout, released_at, scryfall_uri, price_eur, price_eur_foil, price_usd, price_usd_foil)
	VALUES (@id, @oracle_id, @name, @mana_cost, 1, @type_line, '', '[]', '[]', '[]', @set_code, @set_name, @collector_number, @rarity, NULL, 'normal', '2024-01-01', 'https://scryfall.com/', 1.0, 2.0, 1.1, 2.2)`);
db.transaction(() => { for (const c of cards) ins.run({ mana_cost: null, ...c }); })();
console.log(`seeded ${cards.length} printings; cards table now has ${db.prepare('SELECT COUNT(*) c FROM cards').get().c} rows`);
