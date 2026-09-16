// Seed data/mtg.db with the printings listed in seed-cards.json so the scanner
// harness can identify cards without a full Scryfall import. The schema must
// exist already: start the dev server once (it runs initDb on the first
// request), then run this script from the repository root.
//
// `--distractors` additionally inserts synthetic printings ("Distractor TMT
// #28") at the collector numbers an OCR misread of a seeded number could
// produce: neighbouring numbers, glyph confusions (3<->8, 1<->7, ...) and a
// dropped digit. A production database has a real card at almost every
// number, so a misread digit yields a *wrong* card there; with the
// distractors in place the harness reports such hits as WRONG instead of
// counting a harmless "not found". Rarities follow a booster-like
// distribution so the rarity plausibility check is exercised realistically.
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
const withDistractors = process.argv.includes('--distractors');
const db = new Database('data/mtg.db');
const cards = JSON.parse(readFileSync(new URL('./seed-cards.json', import.meta.url), 'utf8'));
const ins = db.prepare(`INSERT OR REPLACE INTO cards (id, oracle_id, name, mana_cost, cmc, type_line, oracle_text, colors, color_identity, keywords,
	set_code, set_name, collector_number, rarity, image_uri, layout, released_at, scryfall_uri, price_eur, price_eur_foil, price_usd, price_usd_foil)
	VALUES (@id, @oracle_id, @name, @mana_cost, 1, @type_line, '', '[]', '[]', '[]', @set_code, @set_name, @collector_number, @rarity, NULL, 'normal', '2024-01-01', 'https://scryfall.com/', 1.0, 2.0, 1.1, 2.2)`);
const rows = withDistractors ? [...cards, ...distractorsFor(cards)] : cards;
db.transaction(() => { for (const c of rows) ins.run({ mana_cost: null, ...c }); })();
console.log(`seeded ${cards.length} printings${withDistractors ? ` + ${rows.length - cards.length} distractors` : ''}; cards table now has ${db.prepare('SELECT COUNT(*) c FROM cards').get().c} rows`);

function distractorsFor(seeded) {
	const confusions = { 0: '689', 1: '74', 2: '7', 3: '85', 4: '19', 5: '36', 6: '058', 7: '12', 8: '036', 9: '04' };
	const taken = new Set(seeded.map((c) => `${c.set_code}|${c.collector_number}`));
	const out = [];
	for (const c of seeded) {
		const m = String(c.collector_number).match(/^(\d+)/);
		if (!m) continue;
		const digits = m[1];
		const num = Number(digits);
		const variants = new Set();
		for (const d of [-1, 1, -10, 10, -100, 100]) if (num + d >= 1) variants.add(String(num + d));
		for (let i = 0; i < digits.length; i++) {
			for (const g of confusions[digits[i]] ?? '') variants.add(String(Number(digits.slice(0, i) + g + digits.slice(i + 1))));
			if (digits.length > 1) variants.add(String(Number(digits.slice(0, i) + digits.slice(i + 1))));
		}
		for (const v of variants) {
			if (v === '0' || v === String(num)) continue;
			const key = `${c.set_code}|${v}`;
			if (taken.has(key)) continue;
			taken.add(key);
			out.push({
				id: `distractor-${c.set_code}-${v}`,
				oracle_id: `o-distractor-${c.set_code}-${v}`,
				name: `Distractor ${c.set_code.toUpperCase()} #${v}`,
				set_code: c.set_code,
				set_name: c.set_name,
				collector_number: v,
				rarity: rarityFor(key),
				type_line: 'Creature'
			});
		}
	}
	return out;
}

/** Deterministic pseudo-random rarity: 45% common, 30% uncommon, 20% rare, 5% mythic. */
function rarityFor(key) {
	let h = 0;
	for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	const r = h % 100;
	return r < 45 ? 'common' : r < 75 ? 'uncommon' : r < 95 ? 'rare' : 'mythic';
}
