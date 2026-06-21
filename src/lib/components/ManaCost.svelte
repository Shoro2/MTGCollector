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

	function pipClass(symbol: string): string {
		const normalized = symbol.toLowerCase();
		if (['w', 'u', 'b', 'r', 'g', 'c'].includes(normalized)) {
			return `mana-pip pip-${normalized}`;
		}
		return 'mana-pip mana-pip-generic';
	}
</script>

{#if symbols.length > 0}
	<span class="mana-cost {className}" aria-label={cost ?? ''}>
		{#each symbols as symbol}
			<span class={pipClass(symbol)}>{symbol}</span>
		{/each}
	</span>
{/if}
