import type { Database } from 'better-sqlite3';
import { cleanLocation, collectionChanges } from '../collection-fields';

export function collectionLocations(db: Database, userId: string) {
	return (db.prepare(`SELECT DISTINCT location FROM collection_cards
		WHERE user_id = ? AND location != '' ORDER BY location COLLATE NOCASE`).all(userId) as { location: string }[])
		.map(row => row.location);
}

/** Validate ownership of every row before changing any row. Never merge purchase lots. */
export function bulkEditCollection(db: Database, userId: string, rawIds: unknown, rawChanges: unknown) {
	if (!Array.isArray(rawIds) || !rawIds.length || rawIds.length > 500 ||
		rawIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Select between 1 and 500 entries.');
	const ids = [...new Set(rawIds as number[])];
	const changes = collectionChanges(rawChanges);
	const placeholders = ids.map(() => '?').join(',');
	return db.transaction(() => {
		const rows = db.prepare(`SELECT id, card_id, language FROM collection_cards
			WHERE user_id = ? AND id IN (${placeholders})`).all(userId, ...ids) as { id: number; card_id: string; language: string }[];
		if (rows.length !== ids.length) throw new Error('Some selected entries are no longer available. Refresh the collection.');
		const entries = Object.entries(changes);
		db.prepare(`UPDATE collection_cards SET ${entries.map(([key]) => `${key} = ?`).join(', ')}
			WHERE user_id = ? AND id IN (${placeholders})`).run(
			...entries.map(([, value]) => typeof value === 'boolean' ? Number(value) : value), userId, ...ids);
		return rows.map(row => ({ cardId: row.card_id, language: changes.language ?? row.language }));
	})();
}

/** Moving a subset preserves quantity, cost, acquisition date, notes and tags. */
export function moveCollectionCopies(db: Database, userId: string, id: unknown, quantity: unknown, location: unknown) {
	if (!Number.isSafeInteger(id) || !Number.isSafeInteger(quantity) || Number(quantity) < 1) throw new Error('Invalid copy count.');
	const target = cleanLocation(location);
	return db.transaction(() => {
		const row = db.prepare('SELECT quantity, location FROM collection_cards WHERE id = ? AND user_id = ?')
			.get(id, userId) as { quantity: number; location: string } | undefined;
		if (!row) throw new Error('This entry is no longer available.');
		if (Number(quantity) > row.quantity) throw new Error('Cannot move more copies than you own.');
		if (target === row.location) return;
		if (quantity === row.quantity) {
			db.prepare('UPDATE collection_cards SET location = ? WHERE id = ? AND user_id = ?').run(target, id, userId);
			return;
		}
		const inserted = db.prepare(`INSERT INTO collection_cards
			(user_id, card_id, quantity, condition, foil, language, purchase_price, notes, added_at, location)
			SELECT user_id, card_id, ?, condition, foil, language, purchase_price, notes, added_at, ?
			FROM collection_cards WHERE id = ? AND user_id = ?`).run(quantity, target, id, userId);
		db.prepare(`INSERT INTO collection_card_tags (collection_card_id, tag_id)
			SELECT ?, tag_id FROM collection_card_tags WHERE collection_card_id = ?`).run(inserted.lastInsertRowid, id);
		db.prepare('UPDATE collection_cards SET quantity = quantity - ? WHERE id = ? AND user_id = ?').run(quantity, id, userId);
	})();
}
