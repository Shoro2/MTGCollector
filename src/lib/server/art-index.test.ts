import { describe, expect, it } from 'vitest';
import { searchHashes, type HashEntry } from './art-index';

const e = (key: string, hash: string): HashEntry => ({ key, hash });

describe('searchHashes', () => {
	const index: HashEntry[] = [
		e('a', '0000000000000000'),
		e('b', '0000000000000003'), // 2 bits from a
		e('c', '00000000000000ff'), // 8 bits from a
		e('d', 'ffffffffffffffff') // 64 bits from a
	];

	it('returns entries within the distance, nearest first, at most `limit`', () => {
		expect(searchHashes(index, '0000000000000000', 10, 5).map((m) => [m.key, m.distance])).toEqual([['a', 0], ['b', 2], ['c', 8]]);
		expect(searchHashes(index, '0000000000000000', 10, 2).map((m) => m.key)).toEqual(['a', 'b']);
		expect(searchHashes(index, '0000000000000000', 1, 5).map((m) => m.key)).toEqual(['a']);
	});

	it('ignores malformed hashes', () => {
		expect(searchHashes(index, 'nope', 10, 5)).toEqual([]);
		expect(searchHashes([e('x', '-')], '0000000000000000', 64, 5)).toEqual([]);
	});
});
