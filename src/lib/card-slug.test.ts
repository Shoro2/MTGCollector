import { describe, expect, it } from 'vitest';
import { assignCardSlugs, isPrintingId, slugifyCardName } from './card-slug';

describe('slugifyCardName', () => {
	it('builds readable ASCII slugs from card names', () => {
		expect(slugifyCardName("Teferi's Protection")).toBe('teferis-protection');
		expect(slugifyCardName('Michiko’s Reign of Truth // Portrait of Michiko')).toBe('michikos-reign-of-truth-portrait-of-michiko');
		expect(slugifyCardName('Lim-Dûl the Necromancer')).toBe('lim-dul-the-necromancer');
		expect(slugifyCardName('Glóin, the Mighty')).toBe('gloin-the-mighty');
		expect(slugifyCardName('Æther Vial')).toBe('aether-vial');
		expect(slugifyCardName('"2 Seconds After Opening the Tuna Can"')).toBe('2-seconds-after-opening-the-tuna-can');
		expect(slugifyCardName('_____')).toBe('');
	});
});

describe('assignCardSlugs', () => {
	const group = (oracleId: string, name: string, token = false) => ({ oracleId, name, token });

	it('gives a unique name its plain slug', () => {
		expect(assignCardSlugs([group('a1', 'Storm Crow')]).get('a1')).toBe('storm-crow');
	});
	it('keeps the plain slug for the one real card when tokens share its name', () => {
		const slugs = assignCardSlugs([group('c0ffee00-1', 'Storm Crow'), group('7a7a7a7a-2', 'Storm Crow', true)]);
		expect(slugs.get('c0ffee00-1')).toBe('storm-crow');
		expect(slugs.get('7a7a7a7a-2')).toBe('storm-crow-7a7a7a7a');
	});
	it('suffixes every member when several real cards or only tokens share a name', () => {
		const real = assignCardSlugs([group('11111111-a', 'Everythingamajig'), group('22222222-b', 'Everythingamajig')]);
		expect([...real.values()]).toEqual(['everythingamajig-11111111', 'everythingamajig-22222222']);
		const tokens = assignCardSlugs([group('33333333-a', 'Soldier', true), group('44444444-b', 'Soldier', true)]);
		expect([...tokens.values()]).toEqual(['soldier-33333333', 'soldier-44444444']);
	});
	it('falls back to the oracle id for names without letters or digits', () => {
		expect(assignCardSlugs([group('55555555-x', '_____')]).get('55555555-x')).toBe('card-55555555');
	});
	it('never yields a slug that looks like a printing id', () => {
		const slugs = assignCardSlugs([group('66666666-a', 'Storm Crow')]);
		for (const slug of slugs.values()) expect(isPrintingId(slug)).toBe(false);
	});
	it('is independent of input order', () => {
		const a = [group('11111111-a', 'Soldier', true), group('22222222-b', 'Soldier'), group('33333333-c', 'Bolt')];
		expect(assignCardSlugs(a)).toEqual(assignCardSlugs([...a].reverse()));
	});
});

describe('isPrintingId', () => {
	it('recognises Scryfall printing ids', () => {
		expect(isPrintingId('50bf546a-83ac-470f-a5c7-2b214d18f5c1')).toBe(true);
		expect(isPrintingId('michiko-konda-truth-seeker')).toBe(false);
		expect(isPrintingId('50BF546A-83AC-470F-A5C7-2B214D18F5C1')).toBe(false);
	});
});
