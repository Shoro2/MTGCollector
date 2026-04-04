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
