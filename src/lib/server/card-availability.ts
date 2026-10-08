/** Scryfall availability metadata, independent of the application database singleton. */
import type Database from 'better-sqlite3';

export function paperAvailability(card: { games?: unknown }): 0 | 1 | null {
	if (!Array.isArray(card.games) || !card.games.every((game) => typeof game === 'string')) return null;
	return card.games.includes('paper') ? 1 : 0;
}

export function ensureAvailabilityColumn(db: Database.Database) {
	const columns = db.prepare('PRAGMA table_info(cards)').all() as Array<{ name: string }>;
	if (!columns.some((c) => c.name === 'is_paper')) db.exec('ALTER TABLE cards ADD COLUMN is_paper INTEGER CHECK (is_paper IN (0, 1))');
}

export function availabilityWriter(db: Database.Database) {
	const update = db.prepare('UPDATE cards SET is_paper = @paper WHERE id = @id AND is_paper IS NOT @paper');
	return (card: { id: string; games?: unknown }): number => {
		const paper = paperAvailability(card);
		return paper === null ? 0 : update.run({ id: card.id, paper }).changes;
	};
}

/** Unknown metadata remains eligible until backfilled; absence of a price is not evidence. */
export const SCANNABLE_CARD = "cards.layout <> 'art_series' AND cards.is_paper IS NOT 0";
