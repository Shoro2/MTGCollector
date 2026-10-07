import { expect, it } from 'vitest';
import { applySessionSet, defaultSession, restoreSession } from './session';
import type { Decision } from './resolve';
const ori = { id: 'ori-243', set_code: 'ori', collector_number: '243' };
const newer = { id: 'new-9', set_code: 'new', collector_number: '9' };
const decision = (): Decision => ({ identity: { state: 'confirmed', name: 'War Horn', score: 1 },
	printing: { row: null, candidates: [ori, newer], state: 'unknown' }, finish: 'unknown', language: 'de', reasons: [] });

it('leaves unrestricted scans exactly unchanged', () => {
	const d = decision(); expect(applySessionSet(d, '')).toBe(d);
});
it('narrows a confirmed identity with the user-selected set', () => {
	expect(applySessionSet(decision(), 'ori').printing).toMatchObject({ row: ori, state: 'confirmed' });
});
it('keeps variants within the same set unresolved', () => {
	const d = decision(); d.printing.candidates.push({ ...ori, id: 'ori-243p', collector_number: '243p' });
	expect(applySessionSet(d, 'ori').printing.state).toBe('unknown');
});
it('does not promote an uncertain identity or suppress contrary evidence', () => {
	const d = decision(); d.identity.state = 'likely';
	expect(applySessionSet(d, 'ori').identity.state).toBe('likely');
	d.identity.state = 'confirmed'; d.printing.row = newer; d.printing.state = 'confirmed';
	expect(applySessionSet(d, 'ori').identity.state).toBe('conflict');
	expect(applySessionSet(decision(), 'ori', ['new']).identity.state).toBe('conflict');
	expect(applySessionSet(decision(), 'missing').identity.state).toBe('conflict');
});
it('restores only valid session settings and defaults safely', () => {
	expect(restoreSession({ setCode: 'invalid', language: 'oops', finish: 'etched', condition: 'oops' }, ['ori'])).toEqual(defaultSession());
	expect(restoreSession({ setCode: 'ori', language: 'de', finish: 'foil', location: 'Box A' }, ['ori'])).toMatchObject({ setCode: 'ori', language: 'de', finish: 'foil', location: 'Box A' });
});
