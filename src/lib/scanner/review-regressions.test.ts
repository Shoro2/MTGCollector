/**
 * Regression tests from the external scanner review of commit 9cfe928
 * (16 Sept 2026). They encode the safer matching contract: exact printing
 * evidence beats digit fragments, and a card's visible face name identifies
 * its canonical "Front // Back" record. Five of the six failed on the reviewed
 * commit.
 */
import { describe, expect, it } from 'vitest';
import { disambiguateReprints } from './pipeline';
import { bestNameMatch } from './similarity';

const botBashingPrintings = [
  { id: 'tmt-85', name: 'Bot Bashing Time', set_code: 'tmt', collector_number: '85' },
  { id: 'tmt-85p', name: 'Bot Bashing Time', set_code: 'ptmt', collector_number: '85p' }
];

describe('review: exact printing evidence must beat arbitrary digit fragments', () => {
  it('preserves the promo suffix and prefers the exact set + full collector number', () => {
    const { match } = disambiguateReprints(botBashingPrintings, 'C 0085p PTMT EN', 'ptmt', '85p');
    expect(match?.id).toBe('tmt-85p');
  });

  it('does not let a copyright-year fragment override an exact printing', () => {
    // Deliberately synthetic printings, not assertions about existing sets/cards.
    const rows = [
      { id: 'wrong', name: 'Example Card', set_code: 'aaa', collector_number: '202' },
      { id: 'correct', name: 'Example Card', set_code: 'bbb', collector_number: '85p' }
    ];
    const { match } = disambiguateReprints(rows, 'C 0085p BBB EN 2026', 'bbb', '85p');
    expect(match?.id).toBe('correct');
  });

  it('does not identify a printing from a copyright year alone', () => {
    const rows = [
      { id: 'wrong', name: 'Example Card', set_code: 'aaa', collector_number: '202' },
      { id: 'other', name: 'Example Card', set_code: 'bbb', collector_number: '101' }
    ];
    const { match } = disambiguateReprints(rows, 'Copyright 2026 Wizards', '', '');
    expect(match).toBeNull();
  });

  it('keeps genuine same-number reprint ambiguity unresolved without set evidence', () => {
    const rows = [
      { id: 'one', name: 'Example Card', set_code: 'aaa', collector_number: '85' },
      { id: 'two', name: 'Example Card', set_code: 'bbb', collector_number: '85' }
    ];
    expect(disambiguateReprints(rows, 'C 0085', '', '85').match).toBeNull();
  });
});

describe('review: visible face names identify their parent card', () => {
  it.each([
    ['Beloved Beggar', 'Beloved Beggar // Generous Soul'],
    ['Mourning Patrol', 'Mourning Patrol // Morning Apparition']
  ])('accepts a perfectly read front name: %s', (visibleName, canonicalName) => {
    // Intended contract: score canonical names AND their face-name aliases,
    // but return the parent canonical name so existing result grouping works.
    const best = bestNameMatch([{ name: canonicalName }], visibleName);
    expect(best.name).toBe(canonicalName);
    expect(best.score).toBeCloseTo(1, 5);
  });
});
