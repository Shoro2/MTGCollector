import { describe, it, expect } from 'vitest';
import { disambiguateReprints } from './pipeline';

const reprints = [
	{ name: 'Lightning Bolt', set_code: 'lea', collector_number: '161' },
	{ name: 'Lightning Bolt', set_code: 'm10', collector_number: '146' },
	{ name: 'Lightning Bolt', set_code: 'sld', collector_number: '1417' }
];

describe('disambiguateReprints', () => {
	it('resolves by a collector number found in the bottom text', () => {
		const { match } = disambiguateReprints(reprints, '0146 M10 EN', '', '');
		expect(match?.set_code).toBe('m10');
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
		// set-only can't disambiguate two 'sld' printings, and no number is present
		const { match } = disambiguateReprints(dup, 'no numbers', 'sld', '');
		expect(match).toBeNull();
	});

	it('always returns the debug log lines for the caller to surface', () => {
		const { log } = disambiguateReprints(reprints, '0146 M10 EN', '', '');
		expect(log.length).toBeGreaterThan(0);
		expect(log[0]).toContain('reprints to disambiguate');
	});
});
