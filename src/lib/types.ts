export interface Card {
	id: string;
	oracleId: string | null;
	name: string;
	manaCost: string | null;
	cmc: number | null;
	typeLine: string | null;
	oracleText: string | null;
	colors: string[] | null;
	colorIdentity: string[] | null;
	keywords: string[] | null;
	setCode: string;
	setName: string;
	collectorNumber: string;
	rarity: string;
	power: string | null;
	toughness: string | null;
	loyalty: string | null;
	imageUri: string | null;
	localImagePath: string | null;
	layout: string;
	legalities: Record<string, string> | null;
	releasedAt: string | null;
	scryfallUri: string | null;
	priceEur: number | null;
	priceEurFoil: number | null;
}

export interface CardFace {
	id: number;
	cardId: string;
	faceIndex: number;
	name: string | null;
	manaCost: string | null;
	typeLine: string | null;
	oracleText: string | null;
	imageUri: string | null;
	power: string | null;
	toughness: string | null;
}

export interface CollectionCard {
	id: number;
	cardId: string;
	quantity: number;
	condition: string;
	foil: boolean;
	notes: string | null;
	addedAt: string;
	card?: Card;
	tags?: Tag[];
}

export interface Tag {
	id: number;
	name: string;
	color: string;
}

export interface PriceHistoryEntry {
	id: number;
	cardId: string;
	priceEur: number | null;
	priceEurFoil: number | null;
	recordedAt: string;
}

export interface SearchFilters {
	query?: string;
	colors?: string[];
	colorMode?: 'include' | 'exact' | 'at_most';
	type?: string;
	setCode?: string;
	rarity?: string;
	cmcMin?: number;
	cmcMax?: number;
	legality?: string;
}

export function parseCardFromDb(row: Record<string, unknown>): Card {
	return {
		...row,
		colors: row.colors ? JSON.parse(row.colors as string) : null,
		colorIdentity: row.colorIdentity
			? JSON.parse(row.colorIdentity as string)
			: null,
		keywords: row.keywords ? JSON.parse(row.keywords as string) : null,
		legalities: row.legalities ? JSON.parse(row.legalities as string) : null
	} as Card;
}
