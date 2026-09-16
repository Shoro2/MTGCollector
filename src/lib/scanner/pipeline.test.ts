import { describe, it, expect } from 'vitest';
import { disambiguateReprints, normalizeCollectorNumber } from './pipeline';

const reprints = [
	{ name: 'Lightning Bolt', set_code: 'lea', collector_number: '161' },
	{ name: 'Lightning Bolt', set_code: 'm10', collector_number: '146' },
	{ name: 'Lightning Bolt', set_code: 'sld', collector_number: '1417' }
];

describe('normalizeCollectorNumber', () => {
	it('strips leading zeros of the numeric part and keeps suffixes', () => {
		expect(normalizeCollectorNumber('0085p')).toBe('85p');
		expect(normalizeCollectorNumber('0146')).toBe('146');
		expect(normalizeCollectorNumber('0')).toBe('0');
		expect(normalizeCollectorNumber('291A')).toBe('291a');
	});
});

describe('disambiguateReprints', () => {
	it('resolves by a structurally parsed collector number', () => {
		const { match } = disambiguateReprints(reprints, '0146 M10 EN', '', '146', 'rarity');
		expect(match?.set_code).toBe('m10');
	});

	it('does not use a weak number on its own', () => {
		const { match } = disambiguateReprints(reprints, '146 something', '', '146', 'weak');
		expect(match).toBeNull();
	});

	it('resolves by parsed set code + collector number', () => {
		const { match } = disambiguateReprints(reprints, 'unreadable', 'lea', '161');
		expect(match?.set_code).toBe('lea');
	});

	it('resolves by set code alone when it is unique', () => {
		const { match } = disambiguateReprints(reprints, 'noise', 'sld', '');
		expect(match?.set_code).toBe('sld');
	});

	it('returns null when nothing disambiguates', () => {
		const { match } = disambiguateReprints(reprints, 'no digits here', '', '');
		expect(match).toBeNull();
	});

	it('does not match on an ambiguous set code shared by multiple printings', () => {
		const dup = [
			{ name: 'Forest', set_code: 'sld', collector_number: '1' },
			{ name: 'Forest', set_code: 'sld', collector_number: '2' }
		];
		const { match } = disambiguateReprints(dup, 'no numbers', 'sld', '');
		expect(match).toBeNull();
	});

	it('always returns the debug log lines for the caller to surface', () => {
		const { log } = disambiguateReprints(reprints, '0146 M10 EN', '', '146', 'rarity');
		expect(log.length).toBeGreaterThan(0);
		expect(log[0]).toContain('reprints to disambiguate');
	});
});

describe('disambiguateReprints — near set code', () => {
	it('accepts a set code one glyph away when exactly one candidate set matches', () => {
		const rows = [
			{ name: 'Bot Bashing Time', set_code: 'tmt', collector_number: '85' },
			{ name: 'Bot Bashing Time', set_code: 'ptmt', collector_number: '85p' }
		];
		expect(disambiguateReprints(rows, 'G 0088 THT ON', 'tht', '88', 'weak').match?.set_code).toBe('tmt');
		expect(disambiguateReprints(rows, 'noise', 'xyz', '', 'none').match).toBeNull();
	});
});
