<script lang="ts">
	import { displayPrice, type PriceFields } from '$lib/utils';

	/**
	 * Renders a printing's list price: non-foil when available, otherwise the
	 * foil price with a small "Foil" marker (foil-only printings used to show
	 * no price at all). `hideEmpty` renders nothing instead of "-".
	 */
	type Props = { card: PriceFields; class?: string; hideEmpty?: boolean };
	let { card, class: className = '', hideEmpty = false }: Props = $props();
	const shown = $derived(displayPrice(card));
</script>

{#if shown}
	<span class={className}>
		{shown.text}{#if shown.foil}<span
				class="foil-chip ml-1 inline-block rounded border px-1 align-middle text-[0.6rem] font-bold uppercase leading-4 tracking-wide"
				title="Only available as foil">Foil</span
			>{/if}
	</span>
{:else if !hideEmpty}
	<span class={className}>-</span>
{/if}
