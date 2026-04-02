import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core';

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
	priceEurFoil: real('price_eur_foil')
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

export const collectionCards = sqliteTable('collection_cards', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	cardId: text('card_id').notNull().references(() => cards.id),
	quantity: integer('quantity').notNull().default(1),
	condition: text('condition').default('near_mint'),
	foil: integer('foil', { mode: 'boolean' }).default(false),
	notes: text('notes'),
	addedAt: text('added_at').$defaultFn(() => new Date().toISOString())
});

export const tags = sqliteTable('tags', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull().unique(),
	color: text('color').default('#3b82f6')
});

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
	recordedAt: text('recorded_at').$defaultFn(() => new Date().toISOString())
});
