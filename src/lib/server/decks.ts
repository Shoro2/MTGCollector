/**
 * Decks: storage, access rules, list import and the reads behind /decks. Takes an
 * injected database (never imports db.ts), so the unit tests run on in-memory SQLite.
 *
 * Access: the owner reads and writes; anyone may read an unlisted or public deck by its
 * random id. A private deck is "not found" for everybody else, so its existence never
 * leaks. Ownership shown next to the cards is always the viewer's own collection.
 */
import type { Database } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import {
	BOARDS, VISIBILITIES, isBoard, isBracket, ownershipKey, pickDeckPrinting, unitPriceEur, deckColors,
	type Board, type Bracket, type CardSuggestion, type Owned, type Visibility
} from '../deck';
import { canHavePartner, canLead, canPair, deckFormat, isDeckFormat, type RuleCard } from '../deck-formats';
import { CONTACT_MESSAGE, cleanUserText, hasContact } from '../user-text';
import { parseDeckList, type DeckLine, type DeckLineIssue } from '../deck-text';
import { slugifyCardName } from '../card-slug';
import type { PrintingSummary } from '../card-page';
import { cardSlugIndex } from './card-slugs';

/** Tables of migration 0027_decks; tests create them the same way. */
export const DECKS_SQL = `
CREATE TABLE IF NOT EXISTS decks (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	format TEXT NOT NULL DEFAULT 'commander',
	description TEXT NOT NULL DEFAULT '',
	visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unlisted', 'public')),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decks_user_updated ON decks(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS deck_cards (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
	card_id TEXT NOT NULL REFERENCES cards(id),
	board TEXT NOT NULL DEFAULT 'main' CHECK (board IN ('commander', 'main', 'sideboard', 'maybeboard')),
	quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 999),
	foil INTEGER NOT NULL DEFAULT 0 CHECK (foil IN (0, 1)),
	UNIQUE (deck_id, board, card_id, foil)
);
CREATE INDEX IF NOT EXISTS idx_deck_cards_card ON deck_cards(card_id);
`;

/**
 * Migration 0028_deck_bracket: the Commander Bracket the owner states (1 to 5, NULL for
 * none), appended as the last column so the positional user-data dump keeps its order.
 * Tests run it after DECKS_SQL like the migration list does.
 */
export function addDeckBracket(db: Database) {
	const columns = db.prepare('PRAGMA table_info(decks)').all() as { name: string }[];
	if (!columns.some((c) => c.name === 'bracket')) db.exec('ALTER TABLE decks ADD COLUMN bracket INTEGER CHECK (bracket BETWEEN 1 AND 5)');
}

/**
 * Migration 0029_deck_reports: reports by signed-in players and the time a deck was hidden
 * after REPORTS_TO_HIDE of them. `hidden_at` is appended after `bracket` (positional dump).
 */
export const DECK_REPORTS_SQL = `
CREATE TABLE IF NOT EXISTS deck_reports (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	reason TEXT NOT NULL CHECK (reason IN ('spam', 'offensive', 'other')),
	created_at TEXT NOT NULL,
	UNIQUE (deck_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_deck_reports_user ON deck_reports(user_id);
CREATE INDEX IF NOT EXISTS idx_decks_public ON decks(visibility, updated_at DESC);
`;

export function addDeckReports(db: Database) {
	const columns = db.prepare('PRAGMA table_info(decks)').all() as { name: string }[];
	if (!columns.some((c) => c.name === 'hidden_at')) db.exec('ALTER TABLE decks ADD COLUMN hidden_at TEXT');
	db.exec(DECK_REPORTS_SQL);
}

/** Distinct accounts whose reports hide a deck's description and take it off the public list. */
export const REPORTS_TO_HIDE = 3;
export const REPORT_REASONS = ['spam', 'offensive', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const MAX_DECKS_PER_USER = 500;
export const MAX_DECK_ROWS = 600;

/** A user-facing error with the HTTP status the endpoints answer with. */
export class DeckError extends Error {
	constructor(message: string, readonly status = 400) {
		super(message);
	}
}
const notFound = () => new DeckError('Deck not found.', 404);

export const newDeckId = () => randomBytes(12).toString('base64url');

export type DeckMeta = { name: string; format: string; visibility: Visibility; description: string; bracket: Bracket | null };
export type DeckRecord = DeckMeta & { id: string; user_id: string; created_at: string; updated_at: string; hidden_at?: string | null };

/** Validates the fields present in `input` (all of them unless `partial`). */
export function deckMeta(input: Record<string, unknown>, partial = false): Partial<DeckMeta> {
	const out: Partial<DeckMeta> = {};
	const given = (key: string) => !partial || input[key] !== undefined;
	if (given('name')) {
		const name = typeof input.name === 'string' ? cleanUserText(input.name, false) : '';
		if (!name || name.length > 100) throw new DeckError('Give the deck a name of 1 to 100 characters.');
		if (hasContact(name)) throw new DeckError(CONTACT_MESSAGE);
		out.name = name;
	}
	if (given('format')) {
		if (!isDeckFormat(input.format)) throw new DeckError('Unknown format.');
		out.format = input.format;
	}
	if (given('visibility')) {
		if (!VISIBILITIES.includes(input.visibility as Visibility)) throw new DeckError('Visibility must be private, unlisted or public.');
		out.visibility = input.visibility as Visibility;
	}
	if (given('description')) {
		const description = input.description ?? '';
		if (typeof description !== 'string' || description.length > 5000) throw new DeckError('The description has at most 5,000 characters.');
		if (hasContact(description)) throw new DeckError(CONTACT_MESSAGE);
		out.description = cleanUserText(description);
	}
	if (given('bracket')) {
		const bracket = input.bracket ?? null;
		if (bracket !== null && !isBracket(bracket)) throw new DeckError('The bracket is a number from 1 to 5.');
		out.bracket = bracket;
	}
	return out;
}

const touch = (db: Database, deckId: string) => db.prepare('UPDATE decks SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), deckId);

function ownDeck(db: Database, userId: string, deckId: string): DeckRecord {
	const deck = db.prepare('SELECT * FROM decks WHERE id = ? AND user_id = ?').get(deckId, userId) as DeckRecord | undefined;
	if (!deck) throw notFound();
	return deck;
}

/** The deck if `viewerId` may read it: the owner always, others unless it is private. */
export function readableDeck(db: Database, deckId: string, viewerId: string | null): DeckRecord | null {
	const deck = db.prepare('SELECT * FROM decks WHERE id = ?').get(deckId) as DeckRecord | undefined;
	if (!deck || (deck.visibility === 'private' && deck.user_id !== viewerId)) return null;
	return deck;
}

type Printing = PrintingSummary & { name: string; oracle_id: string | null; layout: string | null; type_line: string | null; oracle_text: string | null };
const PRINTING_COLUMNS = `id, name, oracle_id, set_code, set_name, collector_number, rarity, released_at, image_uri, local_image_path,
	price_eur, price_usd, price_eur_foil, price_usd_foil, is_paper, layout, type_line, oracle_text`;
const NOT_ART = "COALESCE(layout, '') != 'art_series'";
const numberKey = (value: string) => value.toLowerCase().replace(/^0+(?=\d)/, '');

/**
 * Resolves list lines to printings. The name decides the card: exactly, as the front
 * face of a double-faced or split card, ignoring case, accents and punctuation (the card
 * slug), as any face, or as a printed non-English name. A set and collector number pick
 * that printing of the card; without them the default printing is used (pickDeckPrinting).
 */
export function cardResolver(db: Database) {
	const exact = db.prepare(`SELECT DISTINCT name FROM cards WHERE name = ? AND ${NOT_ART}`);
	const front = db.prepare(`SELECT DISTINCT name FROM cards WHERE name >= ? AND name < ? AND ${NOT_ART} LIMIT 3`);
	const byOracle = db.prepare(`SELECT name FROM cards WHERE oracle_id = ? AND ${NOT_ART} LIMIT 1`);
	const face = db.prepare(`SELECT DISTINCT c.name FROM card_faces f JOIN cards c ON c.id = f.card_id
		WHERE f.name = ? COLLATE NOCASE AND COALESCE(c.layout, '') != 'art_series' LIMIT 3`);
	const printed = db.prepare('SELECT DISTINCT name FROM card_names WHERE printed_name = ? COLLATE NOCASE LIMIT 3');
	const printingsOf = db.prepare(`SELECT ${PRINTING_COLUMNS} FROM cards WHERE name = ? AND ${NOT_ART}`);
	const inSet = db.prepare(`SELECT ${PRINTING_COLUMNS} FROM cards WHERE set_code = ? AND ${NOT_ART}`);
	const names = new Map<string, string | null>();
	const printings = new Map<string, Printing[]>();
	const sets = new Map<string, Printing[]>();
	const one = (rows: { name: string }[]) => (rows.length === 1 ? rows[0].name : null);

	const canonical = (name: string): string | null => {
		if (names.has(name)) return names.get(name)!;
		let found = one(exact.all(name) as { name: string }[]) ?? one(front.all(`${name} // `, `${name} //￿`) as { name: string }[]);
		if (!found) {
			const oracleId = cardSlugIndex(db).bySlug.get(slugifyCardName(name));
			found = oracleId ? ((byOracle.get(oracleId) as { name: string } | undefined)?.name ?? null) : null;
		}
		found ??= one(face.all(name) as { name: string }[]);
		if (!found) {
			try {
				found = one(printed.all(name) as { name: string }[]);
			} catch {
				// A database without migration 0022 has no printed names.
			}
		}
		names.set(name, found);
		return found;
	};
	const allPrintings = (name: string) => {
		if (!printings.has(name)) printings.set(name, printingsOf.all(name) as Printing[]);
		return printings.get(name)!;
	};
	const setPrinting = (set: string, number: string) => {
		if (!sets.has(set)) sets.set(set, inSet.all(set) as Printing[]);
		return sets.get(set)!.filter((p) => numberKey(p.collector_number) === numberKey(number));
	};

	return (line: Pick<DeckLine, 'name' | 'set' | 'number'>): { card: Printing; note?: string } | { error: string } => {
		const name = canonical(line.name);
		const wanted = line.set && line.number ? setPrinting(line.set, line.number) : [];
		const where = `${line.set.toUpperCase()} ${line.number}`;
		if (!name) {
			if (wanted.length === 1) return { card: wanted[0], note: `"${line.name}" is unknown; used ${wanted[0].name} from ${where}.` };
			return { error: `No card named "${line.name}".` };
		}
		const match = wanted.find((p) => p.name === name);
		if (match) return { card: match };
		const all = allPrintings(name);
		const inThatSet = line.set ? all.filter((p) => p.set_code === line.set) : [];
		const fallback = (inThatSet.length === 1 ? inThatSet[0] : null) ?? pickDeckPrinting(all);
		if (!fallback) return { error: `No printing of ${name} found.` };
		const note = line.set && line.number ? `${where} is not a printing of ${name}; used ${fallback.set_code.toUpperCase()} ${fallback.collector_number}.` : undefined;
		return { card: fallback, note };
	};
}

type PairCard = Pick<RuleCard, 'name' | 'type_line' | 'oracle_text'> & { id: string };

/** A card with the rules text of every face, for commander and partner checks. */
function pairCard(db: Database, cardId: string): PairCard | undefined {
	return db.prepare(`SELECT id, name, type_line,
			COALESCE(oracle_text, (SELECT group_concat(f.oracle_text, char(10)) FROM card_faces f WHERE f.card_id = cards.id)) AS oracle_text
		FROM cards WHERE id = ? AND ${NOT_ART}`).get(cardId) as PairCard | undefined;
}

export type ImportResult = { added: number; issues: DeckLineIssue[]; notes: DeckLineIssue[] };

const upsertCard = (db: Database) => db.prepare(`INSERT INTO deck_cards (deck_id, card_id, board, quantity, foil) VALUES (?, ?, ?, ?, ?)
	ON CONFLICT (deck_id, board, card_id, foil) DO UPDATE SET quantity = MIN(999, quantity + excluded.quantity)`);

function assertRowLimit(db: Database, deckId: string) {
	const { n } = db.prepare('SELECT COUNT(*) AS n FROM deck_cards WHERE deck_id = ?').get(deckId) as { n: number };
	if (n > MAX_DECK_ROWS) throw new DeckError(`A deck holds at most ${MAX_DECK_ROWS} different entries.`);
}

/** Writes a parsed list into a deck (inside the caller's transaction). */
function writeList(db: Database, deck: DeckRecord, text: string, mode: 'add' | 'replace'): ImportResult {
	let parsed: ReturnType<typeof parseDeckList>;
	try {
		parsed = parseDeckList(text);
	} catch (error) {
		throw new DeckError((error as Error).message);
	}
	const resolve = cardResolver(db);
	const issues = [...parsed.issues];
	const notes: DeckLineIssue[] = [];
	const ready: { line: DeckLine; card: Printing }[] = [];
	for (const line of parsed.entries) {
		const result = resolve(line);
		if ('error' in result) issues.push({ line: line.line, text: `${line.quantity} ${line.name}`, message: result.error });
		else {
			ready.push({ line, card: result.card });
			if (result.note) notes.push({ line: line.line, text: `${line.quantity} ${line.name}`, message: result.note });
		}
	}
	if (mode === 'replace') db.prepare('DELETE FROM deck_cards WHERE deck_id = ?').run(deck.id);
	// MTGO writes a Commander deck's commander as a sideboard of one or two cards.
	const format = deckFormat(deck.format);
	const hasCommander = db.prepare("SELECT 1 FROM deck_cards WHERE deck_id = ? AND board = 'commander'").get(deck.id);
	const side = ready.filter((r) => r.line.board === 'sideboard');
	if (parsed.implicitSideboard && format.kind === 'commander' && format.command && format.command !== 'oathbreaker' && !hasCommander &&
		!ready.some((r) => r.line.board === 'commander') && side.length && side.reduce((n, r) => n + r.line.quantity, 0) <= 2 &&
		side.every((r) => canLead(r.card, format.command!))) {
		for (const r of side) r.line.board = 'commander';
	}
	const upsert = upsertCard(db);
	for (const { line, card } of ready) upsert.run(deck.id, card.id, line.board, line.quantity, line.foil ? 1 : 0);
	assertRowLimit(db, deck.id);
	touch(db, deck.id);
	return { added: ready.reduce((n, r) => n + r.line.quantity, 0), issues, notes };
}

/**
 * Creates a deck, optionally with its commander, a partner for it (a second commander
 * the two cards' abilities allow, see canPair()) and a pasted list.
 */
export function createDeck(db: Database, userId: string, input: Record<string, unknown>) {
	const meta = deckMeta({ format: 'commander', visibility: 'private', description: '', bracket: null, ...input }) as DeckMeta;
	const list = input.list ?? '';
	if (typeof list !== 'string') throw new DeckError('The card list must be text.');
	const commanderId = input.commanderId ? String(input.commanderId) : null;
	const partnerId = input.partnerId ? String(input.partnerId) : null;
	if (partnerId && !commanderId) throw new DeckError('Choose the commander before its partner.');
	return db.transaction(() => {
		const { n } = db.prepare('SELECT COUNT(*) AS n FROM decks WHERE user_id = ?').get(userId) as { n: number };
		if (n >= MAX_DECKS_PER_USER) throw new DeckError(`You can keep at most ${MAX_DECKS_PER_USER} decks.`);
		const now = new Date().toISOString();
		const id = newDeckId();
		db.prepare('INSERT INTO decks (id, user_id, name, format, description, visibility, bracket, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
			.run(id, userId, meta.name, meta.format, meta.description, meta.visibility, meta.bracket, now, now);
		const deck = ownDeck(db, userId, id);
		const leaders: PairCard[] = [];
		if (commanderId) {
			const commander = pairCard(db, commanderId);
			if (!commander) throw new DeckError('The chosen commander is not in the catalogue.');
			leaders.push(commander);
		}
		if (partnerId) {
			const partner = pairCard(db, partnerId);
			if (!partner) throw new DeckError('The chosen partner is not in the catalogue.');
			if (partner.id === leaders[0].id || !canPair(leaders[0], partner)) {
				throw new DeckError(`${partner.name} cannot share the command zone with ${leaders[0].name}.`);
			}
			leaders.push(partner);
		}
		for (const leader of leaders) upsertCard(db).run(id, leader.id, 'commander', 1, 0);
		const result: ImportResult = list.trim() ? writeList(db, deck, list, 'add') : { added: 0, issues: [], notes: [] };
		// A pasted list often repeats the commanders chosen in the dialog; they belong in the command zone only.
		for (const leader of leaders) {
			const dup = db.prepare(`SELECT dc.id, dc.quantity FROM deck_cards dc JOIN cards c ON c.id = dc.card_id
				WHERE dc.deck_id = ? AND dc.board = 'main' AND c.name = ? ORDER BY dc.id LIMIT 1`).get(id, leader.name) as { id: number; quantity: number } | undefined;
			if (dup && dup.quantity > 1) db.prepare('UPDATE deck_cards SET quantity = quantity - 1 WHERE id = ?').run(dup.id);
			else if (dup) db.prepare('DELETE FROM deck_cards WHERE id = ?').run(dup.id);
		}
		return { id, ...result };
	})();
}

export function updateDeck(db: Database, userId: string, deckId: string, input: Record<string, unknown>) {
	const changes = Object.entries(deckMeta(input, true));
	if (!changes.length) throw new DeckError('Nothing to change.');
	ownDeck(db, userId, deckId);
	db.prepare(`UPDATE decks SET ${changes.map(([key]) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND user_id = ?`)
		.run(...changes.map(([, value]) => value), new Date().toISOString(), deckId, userId);
}

export function deleteDeck(db: Database, userId: string, deckId: string) {
	if (!db.prepare('DELETE FROM decks WHERE id = ? AND user_id = ?').run(deckId, userId).changes) throw notFound();
}

/** A private copy in the viewer's account: their own deck or anyone's shared one. */
export function copyDeck(db: Database, viewerId: string, deckId: string): string {
	return db.transaction(() => {
		const source = readableDeck(db, deckId, viewerId);
		if (!source) throw notFound();
		const { n } = db.prepare('SELECT COUNT(*) AS n FROM decks WHERE user_id = ?').get(viewerId) as { n: number };
		if (n >= MAX_DECKS_PER_USER) throw new DeckError(`You can keep at most ${MAX_DECKS_PER_USER} decks.`);
		const id = newDeckId();
		const now = new Date().toISOString();
		const name = source.user_id === viewerId ? `${source.name} (copy)`.slice(0, 100) : source.name;
		db.prepare("INSERT INTO decks (id, user_id, name, format, description, visibility, bracket, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'private', ?, ?, ?)")
			.run(id, viewerId, name, source.format, source.hidden_at && source.user_id !== viewerId ? '' : source.description, source.bracket ?? null, now, now);
		db.prepare(`INSERT INTO deck_cards (deck_id, card_id, board, quantity, foil)
			SELECT ?, card_id, board, quantity, foil FROM deck_cards WHERE deck_id = ? ORDER BY id`).run(id, deckId);
		return id;
	})();
}

function cardFields(input: Record<string, unknown>) {
	const out: { cardId?: string; board?: Board; quantity?: number; foil?: number } = {};
	if (input.cardId !== undefined) {
		if (typeof input.cardId !== 'string' || !input.cardId) throw new DeckError('Choose a card.');
		out.cardId = input.cardId;
	}
	if (input.board !== undefined) {
		if (!isBoard(input.board)) throw new DeckError(`The board must be one of ${BOARDS.join(', ')}.`);
		out.board = input.board;
	}
	if (input.quantity !== undefined) {
		if (!Number.isSafeInteger(input.quantity) || Number(input.quantity) < 1 || Number(input.quantity) > 999) {
			throw new DeckError('Quantity must be a whole number from 1 to 999.');
		}
		out.quantity = Number(input.quantity);
	}
	if (input.foil !== undefined) out.foil = input.foil ? 1 : 0;
	return out;
}

const cardExists = (db: Database, cardId: string) =>
	db.prepare(`SELECT id, name, oracle_id FROM cards WHERE id = ? AND ${NOT_ART}`).get(cardId) as { id: string; name: string; oracle_id: string | null } | undefined;

export function addDeckCard(db: Database, userId: string, deckId: string, input: Record<string, unknown>) {
	const fields = cardFields(input);
	if (!fields.cardId) throw new DeckError('Choose a card.');
	return db.transaction(() => {
		ownDeck(db, userId, deckId);
		const card = cardExists(db, fields.cardId!);
		if (!card) throw new DeckError('This card is not in the catalogue.');
		upsertCard(db).run(deckId, card.id, fields.board ?? 'main', fields.quantity ?? 1, fields.foil ?? 0);
		assertRowLimit(db, deckId);
		touch(db, deckId);
		return card;
	})();
}

type DeckCardRecord = { id: number; deck_id: string; card_id: string; board: Board; quantity: number; foil: number };

/**
 * Changes quantity, board, finish or printing of one entry. Another printing must be the
 * same card. An entry that then equals an existing one is merged into it.
 */
export function updateDeckCard(db: Database, userId: string, deckId: string, rowId: unknown, input: Record<string, unknown>) {
	const fields = cardFields(input);
	if (!Object.keys(fields).length) throw new DeckError('Nothing to change.');
	return db.transaction(() => {
		ownDeck(db, userId, deckId);
		const row = db.prepare('SELECT * FROM deck_cards WHERE id = ? AND deck_id = ?').get(rowId, deckId) as DeckCardRecord | undefined;
		if (!row) throw new DeckError('This card is no longer in the deck. Reload the page.', 404);
		const next = { card_id: fields.cardId ?? row.card_id, board: fields.board ?? row.board, quantity: fields.quantity ?? row.quantity, foil: fields.foil ?? row.foil };
		if (next.card_id !== row.card_id) {
			const [from, to] = [cardExists(db, row.card_id), cardExists(db, next.card_id)];
			if (!from || !to || ownershipKey(from) !== ownershipKey(to)) throw new DeckError('Choose a printing of the same card.');
		}
		if (next.card_id === row.card_id && next.board === row.board && next.foil === row.foil) {
			db.prepare('UPDATE deck_cards SET quantity = ? WHERE id = ?').run(next.quantity, row.id);
		} else {
			db.prepare('DELETE FROM deck_cards WHERE id = ?').run(row.id);
			upsertCard(db).run(deckId, next.card_id, next.board, next.quantity, next.foil);
		}
		touch(db, deckId);
	})();
}

export function removeDeckCard(db: Database, userId: string, deckId: string, rowId: unknown) {
	db.transaction(() => {
		ownDeck(db, userId, deckId);
		if (!db.prepare('DELETE FROM deck_cards WHERE id = ? AND deck_id = ?').run(rowId, deckId).changes) {
			throw new DeckError('This card is no longer in the deck. Reload the page.', 404);
		}
		touch(db, deckId);
	})();
}

/** Imports a list into an existing deck: add to it, or replace every card. */
export function importDeckList(db: Database, userId: string, deckId: string, text: unknown, mode: unknown): ImportResult {
	if (typeof text !== 'string' || !text.trim()) throw new DeckError('Paste a card list or choose a file.');
	if (mode !== 'add' && mode !== 'replace') throw new DeckError('Choose whether to add the cards or replace the deck.');
	return db.transaction(() => writeList(db, ownDeck(db, userId, deckId), text, mode))();
}

export type DeckCardRow = {
	id: number; board: Board; quantity: number; foil: number; card_id: string; name: string; oracle_id: string | null;
	type_line: string | null; mana_cost: string | null; cmc: number | null; colors: string[] | null; color_identity: string[]; oracle_text: string | null;
	legalities: string | null; set_code: string; set_name: string; collector_number: string; rarity: string;
	image_uri: string | null; local_image_path: string | null; layout: string | null;
	price_eur: number | null; price_eur_foil: number | null; price_usd: number | null; price_usd_foil: number | null;
};

/** Every entry of a deck with what the views, the rules and the prices need. */
export function deckCards(db: Database, deckId: string): DeckCardRow[] {
	const rows = db.prepare(`
		SELECT dc.id, dc.board, dc.quantity, dc.foil, dc.card_id, c.name, c.oracle_id, c.type_line, c.cmc, c.colors, c.color_identity,
			COALESCE(c.mana_cost, (SELECT f.mana_cost FROM card_faces f WHERE f.card_id = c.id ORDER BY f.face_index LIMIT 1)) AS mana_cost,
			COALESCE(c.oracle_text, (SELECT group_concat(f.oracle_text, char(10)) FROM card_faces f WHERE f.card_id = c.id)) AS oracle_text,
			c.legalities, c.set_code, c.set_name, c.collector_number, c.rarity, c.image_uri, c.local_image_path, c.layout,
			c.price_eur, c.price_eur_foil, c.price_usd, c.price_usd_foil
		FROM deck_cards dc JOIN cards c ON c.id = dc.card_id
		WHERE dc.deck_id = ?
		ORDER BY dc.id
	`).all(deckId) as (Omit<DeckCardRow, 'colors' | 'color_identity'> & { colors: string | null; color_identity: string | null })[];
	// No stored colors (double-faced cards keep them on their faces) stays null, so the
	// frame falls back to the mana cost.
	return rows.map((row) => ({ ...row, colors: row.colors == null ? null : parseColors(row.colors), color_identity: parseColors(row.color_identity) }));
}

function parseColors(value: string | null): string[] {
	try {
		const list = value ? JSON.parse(value) : [];
		return Array.isArray(list) ? list.filter((c): c is string => typeof c === 'string') : [];
	} catch {
		return [];
	}
}

/** The viewer's copies per card (any printing, any language), real and proxy apart. */
export function ownedCards(db: Database, userId: string, keys: string[]): Map<string, Owned> {
	if (!keys.length) return new Map();
	const rows = db.prepare(`
		SELECT COALESCE(c.oracle_id, 'name:' || c.name) AS k,
			SUM(CASE WHEN cc.proxy = 0 THEN cc.quantity ELSE 0 END) AS real,
			SUM(CASE WHEN cc.proxy = 1 THEN cc.quantity ELSE 0 END) AS proxy
		FROM collection_cards cc JOIN cards c ON c.id = cc.card_id
		WHERE cc.user_id = ? AND COALESCE(c.oracle_id, 'name:' || c.name) IN (SELECT value FROM json_each(?))
		GROUP BY k
	`).all(userId, JSON.stringify([...new Set(keys)])) as { k: string; real: number; proxy: number }[];
	return new Map(rows.map((r) => [r.k, { real: r.real, proxy: r.proxy }]));
}

/** The printings (ids) among `cardIds` the viewer holds real copies of. */
export function ownedPrintings(db: Database, userId: string, cardIds: string[]): Set<string> {
	if (!cardIds.length) return new Set();
	const rows = db.prepare(`SELECT DISTINCT card_id FROM collection_cards WHERE user_id = ? AND proxy = 0 AND quantity > 0
		AND card_id IN (SELECT value FROM json_each(?))`).all(userId, JSON.stringify([...new Set(cardIds)])) as { card_id: string }[];
	return new Set(rows.map((r) => r.card_id));
}

export type DeckSummary = {
	id: string; name: string; format: string; visibility: Visibility; bracket: Bracket | null; created_at: string; updated_at: string;
	cards: number; sideboard: number; value: number; unpriced: number; colors: string[];
	commander: { name: string; image_uri: string | null } | null;
};

type DeckHead = Omit<DeckSummary, 'cards' | 'sideboard' | 'value' | 'unpriced' | 'colors' | 'commander'>;
type SummaryRow = Parameters<typeof unitPriceEur>[0] & { deck_id: string; board: Board; quantity: number; name: string; image_uri: string | null; color_identity: string | null };
const SUMMARY_COLUMNS = `dc.deck_id, dc.board, dc.quantity, dc.foil, c.name, c.image_uri, c.color_identity,
	c.price_eur, c.price_eur_foil, c.price_usd, c.price_usd_foil`;

/** Card counts, value, colors and the commanders ("A & B" for partners) of each deck. */
function summarize(decks: DeckHead[], rows: SummaryRow[], usdToEur: number): DeckSummary[] {
	const byDeck = new Map<string, SummaryRow[]>();
	for (const row of rows) {
		const list = byDeck.get(row.deck_id);
		if (list) list.push(row);
		else byDeck.set(row.deck_id, [row]);
	}
	return decks.map((deck) => {
		const list = byDeck.get(deck.id) ?? [];
		let value = 0, unpriced = 0;
		for (const row of list) {
			if (row.board === 'maybeboard') continue;
			const price = unitPriceEur(row, usdToEur);
			if (price == null) unpriced += row.quantity;
			else value += price * row.quantity;
		}
		const count = (boards: Board[]) => list.filter((r) => boards.includes(r.board)).reduce((n, r) => n + r.quantity, 0);
		const commanders = list.filter((r) => r.board === 'commander');
		return {
			...deck,
			cards: count(['commander', 'main']),
			sideboard: count(['sideboard']),
			value: Math.round(value * 100) / 100,
			unpriced,
			colors: deckColors(list.map((r) => ({ board: r.board, color_identity: parseColors(r.color_identity) }))),
			commander: commanders.length ? { name: commanders.map((r) => r.name).join(' & '), image_uri: commanders[0].image_uri } : null
		};
	});
}

/** The owner's decks, newest change first. */
export function listDecks(db: Database, userId: string, usdToEur: number): DeckSummary[] {
	const decks = db.prepare('SELECT id, name, format, visibility, bracket, created_at, updated_at FROM decks WHERE user_id = ? ORDER BY updated_at DESC')
		.all(userId) as DeckHead[];
	const rows = db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id JOIN cards c ON c.id = dc.card_id
		WHERE d.user_id = ? ORDER BY dc.id`).all(userId) as SummaryRow[];
	return summarize(decks, rows, usdToEur);
}

export const PUBLIC_DECK_SORTS = ['updated', 'name', 'cards'] as const;
export type PublicDeckSort = (typeof PUBLIC_DECK_SORTS)[number];
export const PUBLIC_PAGE_SIZE = 30;
const PUBLIC_ORDER: Record<PublicDeckSort, string> = {
	updated: 'updated_at DESC, id',
	name: 'name COLLATE NOCASE, id',
	cards: 'cards DESC, updated_at DESC, id'
};
const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Everybody's public decks, for visitors too: never the owner, never a hidden deck (see
 * reportDeck), never an empty one. `q` searches deck names and commanders.
 */
export function publicDecks(db: Database, query: { q?: string; format?: string; sort?: PublicDeckSort; page?: number }, usdToEur: number) {
	const q = (query.q ?? '').trim().slice(0, 100);
	const format = query.format && isDeckFormat(query.format) ? query.format : '';
	const sort = query.sort && PUBLIC_DECK_SORTS.includes(query.sort) ? query.sort : 'updated';
	const listed = `
		WITH listed AS (
			SELECT d.id, d.name, d.format, d.visibility, d.bracket, d.created_at, d.updated_at,
				(SELECT COALESCE(SUM(quantity), 0) FROM deck_cards WHERE deck_id = d.id AND board IN ('commander', 'main')) AS cards
			FROM decks d
			WHERE d.visibility = 'public' AND d.hidden_at IS NULL AND (@format = '' OR d.format = @format)
				AND (@q = '' OR d.name LIKE @like ESCAPE '\\' OR EXISTS (
					SELECT 1 FROM deck_cards dc JOIN cards c ON c.id = dc.card_id
					WHERE dc.deck_id = d.id AND dc.board = 'commander' AND c.name LIKE @like ESCAPE '\\'))
		)`;
	const params = { q, format, like: likePattern(q) };
	const { total } = db.prepare(`${listed} SELECT COUNT(*) AS total FROM listed WHERE cards > 0`).get(params) as { total: number };
	const pages = Math.max(1, Math.ceil(total / PUBLIC_PAGE_SIZE));
	const page = Math.min(Math.max(1, Math.floor(query.page ?? 1) || 1), pages);
	const heads = db.prepare(`${listed} SELECT id, name, format, visibility, bracket, created_at, updated_at FROM listed WHERE cards > 0
		ORDER BY ${PUBLIC_ORDER[sort]} LIMIT @limit OFFSET @offset`).all({ ...params, limit: PUBLIC_PAGE_SIZE, offset: (page - 1) * PUBLIC_PAGE_SIZE }) as DeckHead[];
	const rows = heads.length
		? (db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM deck_cards dc JOIN cards c ON c.id = dc.card_id
			WHERE dc.deck_id IN (SELECT value FROM json_each(?)) ORDER BY dc.id`).all(JSON.stringify(heads.map((d) => d.id))) as SummaryRow[])
		: [];
	return { decks: summarize(heads, rows, usdToEur), total, page, pages, q, format, sort };
}

/**
 * A signed-in player reports someone else's shared deck, once per deck. When REPORTS_TO_HIDE
 * accounts have reported it, the deck is hidden: other viewers no longer see its
 * description and it leaves the public list. Nobody has to act; the admin can restore it.
 */
export function reportDeck(db: Database, userId: string, deckId: string, reason: unknown): { hidden: boolean } {
	if (!REPORT_REASONS.includes(reason as ReportReason)) throw new DeckError('Choose a reason.');
	return db.transaction(() => {
		const deck = readableDeck(db, deckId, userId);
		if (!deck) throw notFound();
		if (deck.user_id === userId) throw new DeckError('You cannot report your own deck.');
		db.prepare('INSERT OR IGNORE INTO deck_reports (deck_id, user_id, reason, created_at) VALUES (?, ?, ?, ?)')
			.run(deckId, userId, reason, new Date().toISOString());
		const { n } = db.prepare('SELECT COUNT(*) AS n FROM deck_reports WHERE deck_id = ?').get(deckId) as { n: number };
		if (n >= REPORTS_TO_HIDE && !deck.hidden_at) db.prepare('UPDATE decks SET hidden_at = ? WHERE id = ?').run(new Date().toISOString(), deckId);
		return { hidden: n >= REPORTS_TO_HIDE };
	})();
}

export const hasReported = (db: Database, userId: string, deckId: string) =>
	!!db.prepare('SELECT 1 FROM deck_reports WHERE deck_id = ? AND user_id = ?').get(deckId, userId);

export type ReportedDeck = { id: string; name: string; visibility: Visibility; hidden_at: string | null; reports: number; reasons: string; last_report: string };

/** Decks with at least one report, for /admin. */
export function reportedDecks(db: Database): ReportedDeck[] {
	return db.prepare(`
		SELECT d.id, d.name, d.visibility, d.hidden_at, COUNT(*) AS reports, GROUP_CONCAT(r.reason, ', ') AS reasons, MAX(r.created_at) AS last_report
		FROM deck_reports r JOIN decks d ON d.id = r.deck_id
		GROUP BY d.id ORDER BY d.hidden_at IS NULL, last_report DESC LIMIT 100
	`).all() as ReportedDeck[];
}

/** Admin: show the deck again and forget its reports. */
export function restoreDeck(db: Database, deckId: string) {
	db.transaction(() => {
		db.prepare('DELETE FROM deck_reports WHERE deck_id = ?').run(deckId);
		db.prepare('UPDATE decks SET hidden_at = NULL WHERE id = ?').run(deckId);
	})();
}

/**
 * Card names for the deck editor's search box (prefix words over the name column), each
 * with its default printing. `commander` keeps cards that may lead the format; `legal`
 * keeps cards legal (or restricted) in it; `partnerOf` (a card id) keeps the cards that
 * may share the command zone with that commander, a Background included.
 */
export function searchDeckCards(
	db: Database, query: string, options: { format?: string; commander?: boolean; legal?: boolean; partnerOf?: string } = {}
): CardSuggestion[] {
	const terms = query.split(/[\s'"‘’“”`´]+/).filter(Boolean).slice(0, 8);
	if (!terms.length || query.trim().length < 2) return [];
	const fts = `name : (${terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' ')})`;
	const format = options.format && isDeckFormat(options.format) && options.format !== 'casual' ? options.format : null;
	const names = (db.prepare(`
		SELECT name FROM cards
		WHERE rowid IN (SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?)
			AND COALESCE(layout, '') NOT IN ('art_series', 'token', 'double_faced_token', 'emblem')
			${options.legal && format ? "AND json_extract(legalities, '$.' || ?) IN ('legal', 'restricted')" : ''}
		GROUP BY name
		ORDER BY lower(name) = lower(?) DESC, lower(name) LIKE lower(?) || '%' DESC, length(name), name
		LIMIT 60
	`).all(...[fts, ...(options.legal && format ? [format] : []), query.trim(), query.trim()]) as { name: string }[]).map((r) => r.name);
	const printingsOf = db.prepare(`SELECT ${PRINTING_COLUMNS}, mana_cost,
			COALESCE(oracle_text, (SELECT group_concat(f.oracle_text, char(10)) FROM card_faces f WHERE f.card_id = cards.id)) AS rules
		FROM cards WHERE name = ? AND ${NOT_ART}`);
	const zone = format ? deckFormat(format).command : 'legendary';
	const lead = options.partnerOf ? pairCard(db, options.partnerOf) : undefined;
	if (options.partnerOf && !lead) return [];
	const out: CardSuggestion[] = [];
	for (const name of names) {
		const found = pickDeckPrinting(printingsOf.all(name) as (Printing & { mana_cost: string | null; rules: string | null })[]);
		if (!found) continue;
		const card = { ...found, oracle_text: found.rules };
		if (lead ? card.name === lead.name || !canPair(lead, card) : options.commander && !canLead(card, zone ?? 'legendary')) continue;
		out.push({
			id: card.id, name: card.name, type_line: card.type_line, mana_cost: card.mana_cost, set_code: card.set_code, image_uri: card.image_uri,
			partner: canHavePartner(card)
		});
		if (out.length >= 12) break;
	}
	return out;
}

/** Every printing of the card a printing belongs to, newest first, for the printing picker. */
export function cardPrintings(db: Database, cardId: string) {
	const card = cardExists(db, cardId);
	if (!card) return [];
	const where = card.oracle_id ? 'oracle_id = ?' : 'name = ?';
	return db.prepare(`SELECT id, set_code, set_name, collector_number, released_at, is_paper,
			price_eur, price_eur_foil, price_usd, price_usd_foil, image_uri, local_image_path
		FROM cards WHERE ${where} AND ${NOT_ART}
		ORDER BY released_at DESC, set_name, collector_number`).all(card.oracle_id ?? card.name) as (PrintingSummary & { is_paper: number | null })[];
}
