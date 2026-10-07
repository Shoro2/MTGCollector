import { LANGUAGES } from './utils';

export const CONDITIONS = [
	{ value: 'near_mint', label: 'Near Mint' },
	{ value: 'lightly_played', label: 'Lightly Played' },
	{ value: 'moderately_played', label: 'Moderately Played' },
	{ value: 'heavily_played', label: 'Heavily Played' },
	{ value: 'damaged', label: 'Damaged' }
];

export function cleanLocation(value: unknown): string {
	if (typeof value !== 'string' || value.trim().length > 120 || /[\u0000-\u001f]/.test(value)) {
		throw new Error('Location must be text of at most 120 characters.');
	}
	return value.trim();
}

export function validLanguage(value: unknown): value is string {
	return typeof value === 'string' && LANGUAGES.some(l => l.code === value);
}

export type CollectionChanges = { location?: string; condition?: string; language?: string; foil?: boolean };

export function collectionChanges(raw: unknown): CollectionChanges {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Choose at least one field to change.');
	const input = raw as Record<string, unknown>;
	const changes: CollectionChanges = {};
	if ('location' in input) changes.location = cleanLocation(input.location);
	if ('condition' in input) {
		if (!CONDITIONS.some(c => c.value === input.condition)) throw new Error('Invalid condition.');
		changes.condition = input.condition as string;
	}
	if ('language' in input) {
		if (!validLanguage(input.language)) throw new Error('Invalid language.');
		changes.language = input.language;
	}
	if ('foil' in input) {
		if (typeof input.foil !== 'boolean') throw new Error('Invalid finish.');
		changes.foil = input.foil;
	}
	if (!Object.keys(changes).length) throw new Error('Choose at least one field to change.');
	return changes;
}
