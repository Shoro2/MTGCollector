<script lang="ts">
	let {
		cost,
		class: className = ''
	}: {
		cost: string | null | undefined;
		class?: string;
	} = $props();

	let symbols = $derived.by(() => {
		if (!cost) return [];
		const matches = cost.match(/\{[^}]+\}/g) ?? [];
		return matches.map((token) => token.slice(1, -1));
	});

	const COLORS = ['w', 'u', 'b', 'r', 'g', 'c'];

	function pipClass(symbol: string): string {
		const normalized = symbol.toLowerCase();
		if (COLORS.includes(normalized)) {
			return `mana-pip pip-${normalized}`;
		}
		if (symbol.includes('/')) return 'mana-pip mana-pip-hybrid';
		return 'mana-pip mana-pip-generic';
	}

	// Hybrid and Phyrexian symbols ("R/W", "2/W", "G/P"): the ring takes both colors, one
	// per half, and the letters drop the slash so they fit the pip.
	function hybridStyle(symbol: string): string | undefined {
		if (!symbol.includes('/')) return undefined;
		const colors = symbol.toLowerCase().split('/').filter((part) => COLORS.includes(part));
		if (!colors.length) return undefined;
		const [a, b = a] = colors.map((c) => `var(--pip-${c})`);
		return `color: ${a}; border-color: ${a} ${b} ${b} ${a}`;
	}
</script>

{#if symbols.length > 0}
	<span class="mana-cost {className}" aria-label={cost ?? ''}>
		{#each symbols as symbol}
			<span class={pipClass(symbol)} style={hybridStyle(symbol)}>{symbol.replace('/', '')}</span>
		{/each}
	</span>
{/if}
