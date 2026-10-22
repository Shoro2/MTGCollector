import { describe, expect, it } from 'vitest';
import { formatLegalities } from './legality';

describe('formatLegalities', () => {
	it('orders known formats, labels them and keeps every status', () => {
		const list = formatLegalities(JSON.stringify({
			vintage: 'restricted', commander: 'legal', standard: 'not_legal', modern: 'banned', paupercommander: 'legal'
		}));
		expect(list.map((f) => f.format)).toEqual(['standard', 'modern', 'vintage', 'commander', 'paupercommander']);
		expect(list.map((f) => f.status)).toEqual(['not_legal', 'banned', 'restricted', 'legal', 'legal']);
		expect(list.find((f) => f.format === 'paupercommander')).toMatchObject({ label: 'Pauper Commander', group: 'multiplayer' });
	});

	it('keeps formats Scryfall adds later, after the known ones', () => {
		const list = formatLegalities({ new_format: 'legal', legacy: 'legal' });
		expect(list.map((f) => f.label)).toEqual(['Legacy', 'New Format']);
		expect(list[1].group).toBe('constructed');
	});

	it('treats unknown status values as not legal', () => {
		expect(formatLegalities({ modern: 'weird' })[0].status).toBe('not_legal');
	});

	it('returns an empty list for missing or broken data', () => {
		expect(formatLegalities(null)).toEqual([]);
		expect(formatLegalities('')).toEqual([]);
		expect(formatLegalities('{not json')).toEqual([]);
		expect(formatLegalities('[1,2]')).toEqual([]);
	});
});
