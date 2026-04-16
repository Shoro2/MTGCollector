// Single source of truth for the base DDL. Both initDb() and the seed
// script call getSchemaSql() so a column added here reaches both fresh
// installs and the seed-from-scratch path. initDb() layers additional
// ALTER TABLE migrations on top for upgrading old databases.

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cards (
	id TEXT PRIMARY KEY,
	oracle_id TEXT,
	name TEXT NOT NULL,
	mana_cost TEXT,
	cmc REAL,
	type_line TEXT,
	oracle_text TEXT,
	colors TEXT,
	color_identity TEXT,
	keywords TEXT,
	set_code TEXT,
	set_name TEXT,
	collector_number TEXT,
	rarity TEXT,
	power TEXT,
	toughness TEXT,
	loyalty TEXT,
	image_uri TEXT,
	local_image_path TEXT,
	layout TEXT,
	legalities TEXT,
	released_at TEXT,
	scryfall_uri TEXT,
	price_eur REAL,
	price_eur_foil REAL,
	price_usd REAL,
	price_usd_foil REAL
);

CREATE TABLE IF NOT EXISTS card_faces (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	card_id TEXT NOT NULL REFERENCES cards(id),
	face_index INTEGER NOT NULL,
	name TEXT,
	mana_cost TEXT,
	type_line TEXT,
	oracle_text TEXT,
	image_uri TEXT,
	power TEXT,
	toughness TEXT
);

CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	google_id TEXT UNIQUE NOT NULL,
	email TEXT NOT NULL,
	name TEXT NOT NULL,
	avatar_url TEXT,
	google_vision_api_key TEXT,
	created_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_cards (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
	card_id TEXT NOT NULL REFERENCES cards(id),
	quantity INTEGER NOT NULL DEFAULT 1,
	condition TEXT DEFAULT 'near_mint',
	foil INTEGER DEFAULT 0,
	purchase_price REAL,
	notes TEXT,
	added_at TEXT
);

CREATE TABLE IF NOT EXISTS tags (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	color TEXT DEFAULT '#3b82f6',
	UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS collection_card_tags (
	collection_card_id INTEGER NOT NULL REFERENCES collection_cards(id) ON DELETE CASCADE,
	tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
	PRIMARY KEY (collection_card_id, tag_id)
);

CREATE TABLE IF NOT EXISTS wishlist_cards (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
	card_id TEXT NOT NULL REFERENCES cards(id),
	priority INTEGER DEFAULT 0,
	notes TEXT,
	added_at TEXT
);

CREATE TABLE IF NOT EXISTS price_history (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	card_id TEXT NOT NULL REFERENCES cards(id),
	price_eur REAL,
	price_eur_foil REAL,
	price_usd REAL,
	price_usd_foil REAL,
	recorded_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name);
CREATE INDEX IF NOT EXISTS idx_cards_set_code ON cards(set_code);
CREATE INDEX IF NOT EXISTS idx_cards_rarity ON cards(rarity);
CREATE INDEX IF NOT EXISTS idx_cards_cmc ON cards(cmc);
CREATE INDEX IF NOT EXISTS idx_cards_oracle_id ON cards(oracle_id);
CREATE INDEX IF NOT EXISTS idx_cards_type_line ON cards(type_line);
CREATE INDEX IF NOT EXISTS idx_cards_released_at ON cards(released_at);
CREATE INDEX IF NOT EXISTS idx_tags_user_id ON tags(user_id);
CREATE INDEX IF NOT EXISTS idx_card_faces_card_id_face ON card_faces(card_id, face_index);
CREATE INDEX IF NOT EXISTS idx_collection_cards_card_id ON collection_cards(card_id);
CREATE INDEX IF NOT EXISTS idx_collection_cards_user_card ON collection_cards(user_id, card_id);
CREATE INDEX IF NOT EXISTS idx_collection_cards_user_id ON collection_cards(user_id);
CREATE INDEX IF NOT EXISTS idx_collection_cards_user_added ON collection_cards(user_id, added_at DESC);
CREATE INDEX IF NOT EXISTS idx_wishlist_cards_card_id ON wishlist_cards(card_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_cards_user_id ON wishlist_cards(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_price_history_card_id ON price_history(card_id);
CREATE INDEX IF NOT EXISTS idx_price_history_recorded_at ON price_history(recorded_at);
CREATE INDEX IF NOT EXISTS idx_price_history_card_recorded ON price_history(card_id, recorded_at DESC);

-- External-content FTS5: the index is stored here but the searchable text is
-- read from cards via its rowid. This avoids duplicating name/type_line/
-- oracle_text in the FTS auxiliary tables (~50–100 MB saved at scale) and
-- keeps writes cheaper. Queries must match via "cards.rowid IN (SELECT rowid
-- FROM cards_fts WHERE cards_fts MATCH ?)". The old content-stored schema
-- (which included a card_id column) is migrated away in db.ts.
CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
	name,
	type_line,
	oracle_text,
	content='cards',
	content_rowid='rowid'
);
`;
