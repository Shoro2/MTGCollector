<script lang="ts">
	import { BRACKETS, BRACKET_LABELS, type Bracket } from '$lib/deck';

	/** Bracket picker for the deck dialogs: none, or one of the five Commander Brackets. */
	let { value = $bindable(null) }: { value: Bracket | null } = $props();
	const id = `bracket-${Math.random().toString(36).slice(2, 9)}`;
</script>

<div class="text-sm">
	<label for={id} class="block text-[var(--color-text-muted)]">Bracket</label>
	<select
		{id}
		value={value ?? ''}
		onchange={(e) => (value = e.currentTarget.value ? (Number(e.currentTarget.value) as Bracket) : null)}
		aria-describedby="{id}-help"
		class="control mt-1 block w-full px-2 text-sm"
	>
		<option value="">No bracket</option>
		{#each BRACKETS as b (b)}<option value={b}>{b}: {BRACKET_LABELS[b]}</option>{/each}
	</select>
	<p id="{id}-help" class="mt-1 text-xs text-[var(--color-text-muted)]">The Commander Bracket you expect the deck to play at. Shown after the deck's name.</p>
</div>
