// Regenerate seed-cards.json from a fully imported database so the harness
// seed carries production-faithful rows: canonical names ("Front // Back"),
// card_faces, layouts and rarities. Reads the printings listed in an
// expectations file (name + set + number) and writes one seed entry per
// distinct printing. Run from the repository root against data/mtg.db.
// usage: node scripts/scanner-harness/export-seed.mjs [--out seed-cards.json] [expectations.json ...]
// Default: the real-photo and the synthetic expectations into seed-cards.json.
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const outPath = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'scripts/scanner-harness/seed-cards.json';
const expectPaths = argv.filter((a, i) => a !== '--out' && argv[i - 1] !== '--out');
if (expectPaths.length === 0) expectPaths.push('scripts/scanner-harness/expectations-real-photos.json', 'scripts/scanner-harness/expectations.json');
const db = new Database(process.env.MTG_DB_PATH ?? 'data/mtg.db', { readonly: true });
const expectations = Object.assign({}, ...expectPaths.map((p) => JSON.parse(readFileSync(p, 'utf8'))));
const byPrinting = db.prepare(`SELECT id, oracle_id, name, mana_cost, type_line, set_code, set_name, collector_number, rarity, layout FROM cards WHERE set_code = ? AND collector_number = ?`);
const faces = db.prepare(`SELECT name, mana_cost, type_line, power, toughness FROM card_faces WHERE card_id = ? ORDER BY face_index`);
const seen = new Map();
let missing = 0;
for (const rows of Object.values(expectations)) {
	for (const e of rows) {
		if (typeof e === 'string') continue;
		const key = `${e.set.toLowerCase()}|${e.number}`;
		if (seen.has(key)) continue;
		const row = byPrinting.get(e.set.toLowerCase(), String(e.number));
		if (!row) { console.error(`not in DB: ${e.name} (${e.set} #${e.number})`); missing++; continue; }
		const entry = { id: row.id, name: row.name, set_code: row.set_code, set_name: row.set_name, collector_number: row.collector_number, rarity: row.rarity, mana_cost: row.mana_cost, type_line: row.type_line, oracle_id: row.oracle_id, layout: row.layout ?? 'normal' };
		const f = faces.all(row.id);
		if (f.length > 1) entry.card_faces = f;
		seen.set(key, entry);
	}
}
writeFileSync(outPath, JSON.stringify([...seen.values()], null, 1) + '\n');
console.log(`wrote ${seen.size} printings to ${outPath}${missing ? `, ${missing} missing` : ''}`);
