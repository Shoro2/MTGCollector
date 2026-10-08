import { describe, expect, it } from 'vitest';
import { IdentityRearm, referenceIdentity } from './identity-rearm';

const hit = (name: string, distance: number) => ({ row: { name }, distance });
describe('reference identity for live replacements', () => {
	it('uses identity rather than printing and rejects close competing names', () => {
		expect(referenceIdentity([hit('A', 4), hit('A', 4), hit('B', 8)])).toBe('A');
		expect(referenceIdentity([hit('A', 4), hit('A', 4), hit('B', 7)])).toBeNull();
		expect(referenceIdentity([hit('B', 10)])).toBeNull();
		expect(referenceIdentity([hit('B', NaN)])).toBeNull();
	});
	it('requires two separated observations of a different confirmed identity', () => {
		const check = new IdentityRearm();
		expect(check.observe('A', 'B', 0)).toBe(false);
		expect(check.observe('A', 'B', 100)).toBe(false);
		expect(check.observe('A', 'B', 1500)).toBe(true);
		check.reset();
		expect(check.observe('A', 'B', 1600)).toBe(false);
	});
	it('fails closed for an unknown baseline, uncertain matches, same card and stale candidates', () => {
		const check = new IdentityRearm();
		for (const name of ['B', 'B']) expect(check.observe(null, name, 1000)).toBe(false);
		expect(check.observe('A', 'A', 2000)).toBe(false);
		expect(check.observe('A', 'B', 2100)).toBe(false);
		expect(check.observe('A', null, 2500)).toBe(false);
		expect(check.observe('A', 'B', 4000)).toBe(false);
		expect(check.observe('A', 'C', 5500)).toBe(false);
		expect(check.observe('A', 'C', 11000)).toBe(false);
	});
});
