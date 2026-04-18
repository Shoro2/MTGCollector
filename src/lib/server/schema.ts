import { sqliteTable, text, integer, real, primaryKey, unique } from 'drizzle-orm/sqlite-core';

export const cards = sqliteTable('cards', {
	id: text('id').primaryKey(),
	oracleId: text('oracle_id'),
	name: text('name').notNull(),
	manaCost: text('mana_cost'),
	cmc: real('cmc'),
	typeLine: text('type_line'),
	oracleText: text('oracle_text'),
	colors: text('colors'),
	colorIdentity: text('color_identity'),
	keywords: text('keywords'),
	setCode: text('set_code'),
	setName: text('set_name'),
	collectorNumber: text('collector_number'),
	rarity: text('rarity'),
	power: text('power'),
	toughness: text('toughness'),
	loyalty: text('loyalty'),
	imageUri: text('image_uri'),
	localImagePath: text('local_image_path'),
	layout: text('layout'),
	legalities: text('legalities'),
	releasedAt: text('released_at'),
	scryfallUri: text('scryfall_uri'),
	priceEur: real('price_eur'),
	priceEurFoil: real('price_eur_foil'),
	priceUsd: real('price_usd'),
	priceUsdFoil: real('price_usd_foil')
});

export const cardFaces = sqliteTable('card_faces', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	cardId: text('card_id').notNull().references(() => cards.id),
	faceIndex: integer('face_index').notNull(),
	name: text('name'),
	manaCost: text('mana_cost'),
	typeLine: text('type_line'),
	oracleText: text('oracle_text'),
	imageUri: text('image_uri'),
	power: text('power'),
	toughness: text('toughness')
});

export const users = sqliteTable('users', {
	id: text('id').primaryKey(),
	googleId: text('google_id').notNull().unique(),
	email: text('email').notNull(),
	name: text('name').notNull(),
	avatarUrl: text('avatar_url'),
	googleVisionApiKey: text('google_vision_api_key'),
	createdAt: text('created_at').$defaultFn(() => new Date().toISOString())
});

export const sessions = sqliteTable('sessions', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
	expiresAt: text('expires_at').notNull()
});

export const collectionCards = sqliteTable('collection_cards', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
	cardId: text('card_id').notNull().references(() => cards.id),
	quantity: integer('quantity').notNull().default(1),
	condition: text('condition').default('near_mint'),
	foil: integer('foil', { mode: 'boolean' }).default(false),
	purchasePrice: real('purchase_price'),
	notes: text('notes'),
	addedAt: text('added_at').$defaultFn(() => new Date().toISOString())
});

export const wishlistCards = sqliteTable('wishlist_cards', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
	cardId: text('card_id').notNull().references(() => cards.id),
	priority: integer('priority').default(0),
	notes: text('notes'),
	addedAt: text('added_at').$defaultFn(() => new Date().toISOString())
});

export const tags = sqliteTable(
	'tags',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		color: text('color').default('#3b82f6')
	},
	(table) => [unique().on(table.userId, table.name)]
);

export const collectionCardTags = sqliteTable(
	'collection_card_tags',
	{
		collectionCardId: integer('collection_card_id')
			.notNull()
			.references(() => collectionCards.id, { onDelete: 'cascade' }),
		tagId: integer('tag_id')
			.notNull()
			.references(() => tags.id, { onDelete: 'cascade' })
	},
	(table) => [primaryKey({ columns: [table.collectionCardId, table.tagId] })]
);

export const priceHistory = sqliteTable('price_history', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	cardId: text('card_id').notNull().references(() => cards.id),
	priceEur: real('price_eur'),
	priceEurFoil: real('price_eur_foil'),
	recordedAt: text('recorded_at').$defaultFn(() => new Date().toISOString()),
	snapshotDate: text('snapshot_date')
});
