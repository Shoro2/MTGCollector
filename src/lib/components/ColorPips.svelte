<script lang="ts">
	let {
		colors = [],
		includeColorless = false,
		class: className = ''
	}: {
		colors?: string[] | null;
		includeColorless?: boolean;
		class?: string;
	} = $props();

	let visibleColors = $derived.by(() => {
		const list = colors?.length ? colors : includeColorless ? ['C'] : [];
		return list.map((color) => color.toUpperCase());
	});
</script>

{#if visibleColors.length > 0}
	<span class="color-pips {className}">
		{#each visibleColors as color}
			<span class="color-pip pip-{color.toLowerCase()}" title={color}>{color}</span>
		{/each}
	</span>
{/if}
