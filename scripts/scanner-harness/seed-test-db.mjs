// Seed the database (data/mtg.db, or MTG_DB_PATH) with the printings listed in seed-cards.json so the scanner
// harness can identify cards without a full Scryfall import. The schema must
// exist already: start the dev server once (it runs initDb on the first
// request), then run this script from the repository root.
//
// `--distractors` additionally inserts synthetic printings ("Distractor TMT
// #28") at the collector numbers an OCR misread of a seeded number could
// produce: neighbouring numbers, glyph confusions (3<->8, 1<->7, ...), a
// dropped digit, and the same number in every other seeded set (misread set
// codes). A production database has a real card at almost every
// number, so a misread digit yields a *wrong* card there; with the
// distractors in place the harness reports such hits as WRONG instead of
// counting a harmless "not found". Rarities follow a booster-like
// distribution so the rarity plausibility check is exercised realistically.
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
const withDistractors = process.argv.includes('--distractors');
const db = new Database(process.env.MTG_DB_PATH ?? 'data/mtg.db');
const cards = JSON.parse(readFileSync(new URL('./seed-cards.json', import.meta.url), 'utf8'));
const ins = db.prepare(`INSERT OR REPLACE INTO cards (id, oracle_id, name, mana_cost, cmc, type_line, oracle_text, colors, color_identity, keywords,
	set_code, set_name, collector_number, rarity, image_uri, layout, released_at, scryfall_uri, price_eur, price_eur_foil, price_usd, price_usd_foil)
	VALUES (@id, @oracle_id, @name, @mana_cost, 1, @type_line, '', '[]', '[]', '[]', @set_code, @set_name, @collector_number, @rarity, NULL, @layout, '2024-01-01', 'https://scryfall.com/', 1.0, 2.0, 1.1, 2.2)`);
const delFaces = db.prepare('DELETE FROM card_faces WHERE card_id = ?');
const insFace = db.prepare(`INSERT INTO card_faces (card_id, face_index, name, mana_cost, type_line, oracle_text, image_uri, power, toughness)
	VALUES (@card_id, @face_index, @name, @mana_cost, @type_line, '', NULL, @power, @toughness)`);
const rows = withDistractors ? [...cards, ...distractorsFor(cards)] : cards;
db.transaction(() => {
	for (const c of rows) {
		ins.run({ mana_cost: null, layout: 'normal', ...c });
		// Double-faced cards: production stores Scryfall's canonical "Front // Back"
		// name on the card and one card_faces row per face; the face names are
		// what the scanner reads on the physical card.
		delFaces.run(c.id);
		if (Array.isArray(c.card_faces)) {
			c.card_faces.forEach((f, i) => insFace.run({ card_id: c.id, face_index: i, mana_cost: null, type_line: null, power: null, toughness: null, ...f }));
		}
	}
})();
console.log(`seeded ${cards.length} printings${withDistractors ? ` + ${rows.length - cards.length} distractors` : ''}; cards table now has ${db.prepare('SELECT COUNT(*) c FROM cards').get().c} rows, card_faces ${db.prepare('SELECT COUNT(*) c FROM card_faces').get().c}`);

function distractorsFor(seeded) {
	const confusions = { 0: '689', 1: '74', 2: '7', 3: '85', 4: '19', 5: '36', 6: '058', 7: '12', 8: '036', 9: '04' };
	const taken = new Set(seeded.map((c) => `${c.set_code}|${c.collector_number}`));
	const sets = new Map(seeded.map((c) => [c.set_code, c.set_name]));
	const out = [];
	const add = (setCode, setName, v) => {
		const key = `${setCode}|${v}`;
		if (taken.has(key)) return;
		taken.add(key);
		out.push({
			id: `distractor-${setCode}-${v}`,
			oracle_id: `o-distractor-${setCode}-${v}`,
			name: `Distractor ${setCode.toUpperCase()} #${v}`,
			set_code: setCode,
			set_name: setName,
			collector_number: v,
			rarity: rarityFor(key),
			type_line: 'Creature'
		});
	};
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
			add(c.set_code, c.set_name, v);
		}
		// Cross-set: the same number in every other seeded set, so a misread set
		// code ("YOW" for "MID", corrected to VOW) lands on a distractor, not on
		// nothing.
		for (const [setCode, setName] of sets) if (setCode !== c.set_code) add(setCode, setName, String(num));
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
