import type { Database } from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { ImportEntry, ImportIssue, parseCollectionImport } from '../collection-import';

type Parsed = ReturnType<typeof parseCollectionImport>;
type Card = { id: string; name: string; set_code: string; set_name: string; collector_number: string };
type Existing = { id: number; card_id: string; quantity: number; condition: string; foil: number; language: string;
	location: string; purchase_price: number | null; notes: string | null; added_at: string | null };
type Ready = ImportEntry & { card: Card; duplicate: boolean };
export type ImportMode = 'append' | 'merge' | 'sync';
const numberKey = (value: string) => value.toLowerCase().replace(/^0+(?=\d)/, '');
const duplicateKey = (cardId: string, row: { condition: string; foil: number; language: string; location: string; purchasePrice: number | null }) =>
	JSON.stringify([cardId, row.condition, row.foil, row.language, row.location, row.purchasePrice]);

/** Resolve exact identifiers or an unambiguous name in its set. Never pick a latest printing. */
function cardMatcher(db: Database) {
	const byId = db.prepare('SELECT id, name, set_code, set_name, collector_number FROM cards WHERE id = ?');
	const bySet = db.prepare('SELECT id, name, set_code, set_name, collector_number FROM cards WHERE set_code = ?');
	const setByName = db.prepare('SELECT DISTINCT set_code FROM cards WHERE set_name = ? COLLATE NOCASE');
	const aliases = db.prepare('SELECT printed_name FROM card_names WHERE name = ? AND lang = ?');
	const sets = new Map<string, Card[]>();
	const setCodes = new Map<string, { set_code: string }[]>();
	const names = new Map<string, string[]>();
	const nameMatches = (row: ImportEntry, card: Card) => {
		if (!row.name) return true;
		const key = `${card.name}/${row.language}`;
		if (!names.has(key)) names.set(key, [card.name, ...card.name.split(' // '),
			...(aliases.all(card.name, row.language) as { printed_name: string }[]).map(r => r.printed_name)].map(n => n.toLowerCase()));
		return names.get(key)!.includes(row.name.toLowerCase());
	};
	return (row: ImportEntry): Card => {
		const exact = row.id ? byId.get(row.id) as Card | undefined : undefined;
		let set = row.set;
		if (!set && row.setName) {
			const key = row.setName.toLowerCase();
			if (!setCodes.has(key)) setCodes.set(key, setByName.all(row.setName) as { set_code: string }[]);
			const matches = setCodes.get(key)!;
			if (matches.length !== 1) throw new Error('Set name is unknown or ambiguous. Supply a set code.');
			set = matches[0].set_code;
		}
		if (exact) {
			if (set && set !== exact.set_code || row.number && numberKey(row.number) !== numberKey(exact.collector_number) || !nameMatches(row, exact)) {
				throw new Error('Scryfall ID disagrees with the supplied name, set or collector number.');
			}
			return exact;
		}
		if (!set || !row.number && !row.name) throw new Error('Provide a Scryfall ID, or a set plus collector number / card name.');
		if (!sets.has(set)) sets.set(set, bySet.all(set) as Card[]);
		const candidates = sets.get(set)!.filter(c => (!row.number || numberKey(c.collector_number) === numberKey(row.number)) && nameMatches(row, c));
		if (!candidates.length) throw new Error('No matching printing in this set. Check the name and collector number.');
		if (candidates.length !== 1) throw new Error('Several printings match. Add the collector number or Scryfall ID.');
		return candidates[0];
	};
}

export function prepareCollectionImport(db: Database, userId: string, parsed: Parsed, mode: ImportMode) {
	if (!['append', 'merge', 'sync'].includes(mode)) throw new Error('Invalid import mode.');
	const existing = db.prepare(`SELECT id, card_id, quantity, condition, foil, COALESCE(language, 'en') AS language,
		location, purchase_price, notes, added_at FROM collection_cards WHERE user_id = ? ORDER BY id`).all(userId) as Existing[];
	const existingKeys = new Set(existing.map(r => duplicateKey(r.card_id, { ...r, purchasePrice: r.purchase_price })));
	const match = cardMatcher(db);
	const issues: ImportIssue[] = [...parsed.issues];
	const entries: Ready[] = [];
	for (const row of parsed.entries) {
		try {
			const card = match(row);
			entries.push({ ...row, card, duplicate: existingKeys.has(duplicateKey(card.id, row)) });
		} catch (error) { issues.push({ line: row.line, name: row.name, message: (error as Error).message }); }
	}
	const ready = entries.filter(row => mode !== 'merge' || !row.duplicate);
	const tagAssignments = db.prepare(`SELECT cct.collection_card_id, t.id, t.name, t.color
		FROM collection_card_tags cct JOIN tags t ON t.id = cct.tag_id
		JOIN collection_cards cc ON cc.id = cct.collection_card_id
		WHERE cc.user_id = ? ORDER BY cct.collection_card_id, t.id`).all(userId);
	const digest = createHash('sha256').update(JSON.stringify([userId, parsed, mode, entries, existing, tagAssignments])).digest('hex');
	return { entries, ready, issues, existing, digest, summary: {
		total: parsed.total, ready: ready.length, copies: ready.reduce((sum, row) => sum + row.quantity, 0),
		duplicates: entries.filter(row => row.duplicate).length, skipped: entries.length - ready.length,
		issues: issues.length, existingEntries: existing.length, existingCopies: existing.reduce((n, r) => n + r.quantity, 0)
	} };
}

export function commitCollectionImport(db: Database, userId: string, parsed: Parsed, mode: ImportMode, digest: string, confirmReplace: boolean) {
	return db.transaction(() => {
		const plan = prepareCollectionImport(db, userId, parsed, mode);
		if (plan.digest !== digest) throw new Error('The file, options or collection changed. Preview the import again.');
		if (mode === 'sync' && (!confirmReplace || plan.issues.length)) throw new Error('Replacement requires explicit confirmation and a file without unresolved rows.');
		if (!plan.ready.length) throw new Error('No entries are ready to import.');
		const dates = new Map<string, string>();
		for (const row of plan.existing) {
			const key = duplicateKey(row.card_id, { ...row, purchasePrice: row.purchase_price });
			if (row.added_at && (!dates.has(key) || row.added_at < dates.get(key)!)) dates.set(key, row.added_at);
		}
		if (mode === 'sync') {
			db.prepare('DELETE FROM collection_card_tags WHERE collection_card_id IN (SELECT id FROM collection_cards WHERE user_id = ?)').run(userId);
			db.prepare('DELETE FROM collection_cards WHERE user_id = ?').run(userId);
		}
		const insert = db.prepare(`INSERT INTO collection_cards
			(user_id, card_id, quantity, condition, foil, language, purchase_price, location, notes, added_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
		const tagFind = db.prepare('SELECT id FROM tags WHERE user_id = ? AND name = ?');
		const tagInsert = db.prepare("INSERT INTO tags(user_id, name, color) VALUES (?, ?, '#3b82f6')");
		const tagLink = db.prepare('INSERT OR IGNORE INTO collection_card_tags(collection_card_id, tag_id) VALUES (?, ?)');
		for (const row of plan.ready) {
			const added = row.addedAt || (mode === 'sync' ? dates.get(duplicateKey(row.card.id, row)) : null) || new Date().toISOString();
			const entry = insert.run(userId, row.card.id, row.quantity, row.condition, row.foil, row.language,
				row.purchasePrice, row.location, row.notes || null, added);
			for (const tag of row.tags) {
				const current = tagFind.get(userId, tag) as { id: number } | undefined;
				const id = current?.id ?? tagInsert.run(userId, tag).lastInsertRowid;
				tagLink.run(entry.lastInsertRowid, id);
			}
		}
		return plan;
	})();
}
