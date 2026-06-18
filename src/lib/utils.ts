const manaSymbolMap: Record<string, string> = {
	W: '☀', U: '💧', B: '💀', R: '🔥', G: '🌲',
	C: '◇', X: 'X', T: '⟳'
};

export function formatManaCost(manaCost: string | null): string {
	if (!manaCost) return '';
	return manaCost.replace(/\{([^}]+)\}/g, (_, symbol) => {
		return manaSymbolMap[symbol] || symbol;
	});
}

export function getColorName(color: string): string {
	const names: Record<string, string> = {
		W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green'
	};
	return names[color] || color;
}

export function getColorClass(color: string): string {
	const classes: Record<string, string> = {
		W: 'bg-yellow-100 text-yellow-800',
		U: 'bg-blue-400 text-blue-900',
		B: 'bg-gray-700 text-gray-100',
		R: 'bg-red-500 text-red-100',
		G: 'bg-green-500 text-green-100'
	};
	return classes[color] || 'bg-gray-500 text-gray-100';
}

export function getRarityColor(rarity: string): string {
	const colors: Record<string, string> = {
		common: '#1a1a1a',
		uncommon: '#708090',
		rare: '#ffd700',
		mythic: '#ff6b35'
	};
	return colors[rarity] || '#666';
}

export function formatPrice(price: number | null, priceUsd?: number | null): string {
	if (price !== null && price !== undefined) return `€${price.toFixed(2)}`;
	if (priceUsd !== null && priceUsd !== undefined) return `$${priceUsd.toFixed(2)}`;
	return '—';
}

/** EUR value for a price-history row: prefer the EUR column, otherwise convert
 *  the USD column at the given rate so USD-only cards still render on the chart. */
export function histEur(eur: number | null, usd: number | null, usdToEur: number): number | null {
	return eur ?? (usd != null ? usd * usdToEur : null);
}

export function conditionLabel(condition: string): string {
	const labels: Record<string, string> = {
		near_mint: 'Near Mint',
		lightly_played: 'Lightly Played',
		moderately_played: 'Moderately Played',
		heavily_played: 'Heavily Played',
		damaged: 'Damaged'
	};
	return labels[condition] || condition;
}

// ISO/Scryfall language codes paired with human-readable labels. The order
// matches the dropdown the UI renders.
export const LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
	{ code: 'en', label: 'English' },
	{ code: 'es', label: 'Spanish' },
	{ code: 'fr', label: 'French' },
	{ code: 'de', label: 'German' },
	{ code: 'it', label: 'Italian' },
	{ code: 'pt', label: 'Portuguese' },
	{ code: 'ja', label: 'Japanese' },
	{ code: 'ko', label: 'Korean' },
	{ code: 'ru', label: 'Russian' },
	{ code: 'zhs', label: 'Simplified Chinese' },
	{ code: 'zht', label: 'Traditional Chinese' },
	{ code: 'he', label: 'Hebrew' },
	{ code: 'la', label: 'Latin' },
	{ code: 'grc', label: 'Ancient Greek' },
	{ code: 'ar', label: 'Arabic' },
	{ code: 'sa', label: 'Sanskrit' },
	{ code: 'ph', label: 'Phyrexian' },
	{ code: 'qya', label: 'Quenya' }
];

const LANG_BY_CODE: Map<string, string> = new Map(LANGUAGES.map((l) => [l.code, l.label]));
const LANG_BY_LABEL: Map<string, string> = new Map(LANGUAGES.map((l) => [l.label.toLowerCase(), l.code]));

export function languageLabel(code: string | null | undefined): string {
	if (!code) return 'English';
	return LANG_BY_CODE.get(code) ?? code;
}

// Tolerant parser for Moxfield's Language column, which exports the full
// English name ("English", "German", ...). Falls back to the raw value when
// it already looks like an ISO code, otherwise to 'en'.
export function parseLanguageInput(input: string | null | undefined): string {
	if (!input) return 'en';
	const trimmed = input.trim();
	if (!trimmed) return 'en';
	const fromLabel = LANG_BY_LABEL.get(trimmed.toLowerCase());
	if (fromLabel) return fromLabel;
	if (LANG_BY_CODE.has(trimmed.toLowerCase())) return trimmed.toLowerCase();
	return 'en';
}

/**
 * Build a Scryfall srcset from a single `image_uri`. Scryfall serves every
 * card at three usable sizes (small 146w, normal 488w, large 672w) on the
 * same URL structure — swapping the size segment yields the variant. Returns
 * `null` for non-Scryfall URLs and for local cached paths, which only exist
 * at a single size on disk.
 */
export function scryfallSrcset(imageUri: string | null | undefined): string | null {
	if (!imageUri) return null;
	const match = imageUri.match(/cards\.scryfall\.io\/(small|normal|large)\//);
	if (!match) return null;
	const current = match[1];
	const make = (size: string) => imageUri.replace(`/${current}/`, `/${size}/`);
	return `${make('small')} 146w, ${make('normal')} 488w, ${make('large')} 672w`;
}

/** Format a price history date for chart labels.
 *  Accepts both effective date strings ("2026-04-03") and full ISO timestamps. */
export function priceDate(dateString: string): string {
	// If it's a plain date (YYYY-MM-DD), parse as noon UTC to avoid timezone shifts
	if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
		return new Date(dateString + 'T12:00:00Z').toLocaleDateString();
	}
	// Full ISO timestamp: shift back if before 10:00 UTC
	const d = new Date(dateString);
	if (d.getUTCHours() < 10) {
		d.setUTCDate(d.getUTCDate() - 1);
	}
	return d.toLocaleDateString();
}
