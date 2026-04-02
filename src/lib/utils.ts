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

export function formatPrice(price: number | null): string {
	if (price === null || price === undefined) return '—';
	return `€${price.toFixed(2)}`;
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
