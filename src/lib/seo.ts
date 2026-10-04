export const SITE_URL = 'https://mtg-collector.com';

// JSON-LD is embedded as raw script text, not HTML-escaped markup.
export function jsonLd(value: unknown): string {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function catalogSeo(search: URLSearchParams, page: number) {
	const params = new URLSearchParams();
	for (const key of ['q', 'color', 'colorMode', 'type', 'set', 'rarity', 'cmcMin', 'cmcMax', 'legality', 'sort', 'dir', 'unique', 'pageSize']) {
		const values = key === 'color' ? search.getAll(key) : [search.get(key)];
		for (const value of values) {
			if (!value) continue;
			if ((key === 'sort' && value === 'name') || (key === 'dir' && value === 'asc') ||
				(key === 'colorMode' && value === 'include') || (key === 'pageSize' && value === '40') ||
				(key === 'unique' && value !== '1')) continue;
			params.append(key, value);
		}
	}
	// Search/filter/sort combinations are useful to visitors but aren't landing pages.
	const noindex = params.size > 0;
	if (page > 1) params.set('page', String(page));
	return { canonical: `${SITE_URL}/cards${params.size ? `?${params}` : ''}`, noindex };
}
