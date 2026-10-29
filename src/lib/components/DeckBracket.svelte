<script lang="ts">
	import { BRACKET_LABELS, isBracket } from '$lib/deck';

	/** The Commander Bracket a deck's owner chose, shown right after the deck's name. */
	let { bracket, compact = false }: { bracket: number | null | undefined; compact?: boolean } = $props();
</script>

{#if isBracket(bracket)}
	<span
		class="chip bracket-chip min-h-0 px-1.5 py-0 align-middle text-[0.68rem]"
		title="Commander Bracket {bracket}: {BRACKET_LABELS[bracket]}"
		data-bracket={bracket}
	>
		{#if compact}B{bracket}{:else}Bracket {bracket}<span class="font-normal text-[var(--color-text-muted)]">{BRACKET_LABELS[bracket]}</span>{/if}
	</span>
{/if}
