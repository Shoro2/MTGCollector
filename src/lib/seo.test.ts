import { describe, expect, it } from 'vitest';
import { catalogSeo, jsonLd, SITE_URL } from './seo';

describe('catalogue indexing', () => {
	it('keeps distinct canonical URLs for catalogue pages', () => {
		expect(catalogSeo(new URLSearchParams('page=1'), 1)).toEqual({ canonical: `${SITE_URL}/cards`, noindex: false });
		expect(catalogSeo(new URLSearchParams('page=2'), 2)).toEqual({ canonical: `${SITE_URL}/cards?page=2`, noindex: false });
	});
	it('removes tracking parameters and explicit defaults without hiding pagination', () => {
		expect(catalogSeo(new URLSearchParams('utm_source=test&page=3&sort=name&dir=asc&pageSize=40'), 3))
			.toEqual({ canonical: `${SITE_URL}/cards?page=3`, noindex: false });
	});
	it('keeps filtered pages distinct but excludes them from the search index', () => {
		const result = catalogSeo(new URLSearchParams('q=Fire & Ice&color=U&color=R&set=tst&page=2'), 2);
		expect(result.noindex).toBe(true);
		const canonical = new URL(result.canonical);
		expect(canonical.searchParams.getAll('color')).toEqual(['U', 'R']);
		expect(canonical.searchParams.get('set')).toBe('tst');
		expect(canonical.searchParams.get('page')).toBe('2');
	});
	it.each(['sort=price', 'dir=desc', 'pageSize=75', 'unique=1', 'q=Forest'])('does not index the variation %s', params => {
		expect(catalogSeo(new URLSearchParams(params), 1).noindex).toBe(true);
	});
});

it('prevents imported card text from closing a JSON-LD script', () => {
	const data = { name: '</script><script>alert(1)</script>', description: 'A & B < C' };
	const output = jsonLd(data);
	expect(output).not.toContain('<');
	expect(JSON.parse(output)).toEqual(data);
});
