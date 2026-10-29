import { describe, expect, it } from 'vitest';
import { cleanUserText, hasContact } from './user-text';

describe('hasContact', () => {
	it('finds links, addresses and invites, also disguised', () => {
		for (const text of [
			'Cheap cards at https://example.com/shop',
			'visit www.cheapcards.example',
			'buy at cheapcards.com today',
			'mtg-deals.shop',
			'join discord.gg/abc123',
			'https://discord.com/invite/abc',
			'DM me on t.me/dealer',
			'cards . com',
			'cards. net for the best prices',
			'cheapcards dot com',
			'cheapcards (dot) com',
			'mail dealer@example.org',
			'dealer (at) example dot com',
			'sub.domain.example.de',
			'link​.com'
		]) {
			expect(hasContact(text), text).toBe(true);
		}
	});

	it('leaves ordinary deck descriptions alone', () => {
		for (const text of [
			'Krenko, Mob Boss makes goblins. It wins on turn 6.',
			'Play B.F.M. (Big Furry Monster) and Ach! Hans, Run!',
			'Ramp first.It wins later.',
			'The end. it was fun. me too. to be honest. in short',
			'Polka dot in the art, 2.5 lands per turn, e.g. combos',
			'Win vs. me at 1:00, 4.0 average mana value',
			'Fire // Ice and Commit // Memory'
		]) {
			expect(hasContact(text), text).toBe(false);
		}
	});
});

describe('cleanUserText', () => {
	it('removes invisible and control characters and extra blank lines', () => {
		expect(cleanUserText('Go​blins‮\u0007 rule')).toBe('Goblins rule');
		expect(cleanUserText('a  \r\nb\n\n\n\n\n\nc ')).toBe('a\nb\n\n\nc');
		expect(cleanUserText('  Krenko \n Goblins\t', false)).toBe('Krenko Goblins');
	});
});
