<script lang="ts">
	import ManaCost from './ManaCost.svelte';
	import type { CardSuggestion } from '$lib/deck';

	/**
	 * Card name search with suggestions (combobox): types two letters, asks
	 * /api/decks/search, picks with the mouse or the arrow keys and Enter.
	 */
	let {
		label,
		placeholder = 'Search a card…',
		format = '',
		commander = false,
		legal = false,
		clearOnSelect = true,
		disabled = false,
		onselect
	}: {
		label: string;
		placeholder?: string;
		format?: string;
		commander?: boolean;
		legal?: boolean;
		clearOnSelect?: boolean;
		disabled?: boolean;
		onselect: (card: CardSuggestion) => void;
	} = $props();

	const listId = `card-search-${Math.random().toString(36).slice(2, 9)}`;
	let query = $state('');
	let results = $state<CardSuggestion[]>([]);
	let open = $state(false);
	let active = $state(-1);
	let loading = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let request = 0;

	async function search() {
		const q = query.trim();
		if (q.length < 2) {
			results = [];
			open = false;
			return;
		}
		const id = ++request;
		loading = true;
		const params = new URLSearchParams({ q });
		if (format) params.set('format', format);
		if (commander) params.set('commander', '1');
		if (legal) params.set('legal', '1');
		try {
			const response = await fetch(`/api/decks/search?${params}`);
			const data = response.ok ? await response.json() : { cards: [] };
			if (id !== request) return;
			results = data.cards;
			open = true;
			active = results.length ? 0 : -1;
		} finally {
			if (id === request) loading = false;
		}
	}

	function onInput() {
		clearTimeout(timer);
		timer = setTimeout(search, 180);
	}

	function choose(card: CardSuggestion) {
		onselect(card);
		query = clearOnSelect ? '' : card.name;
		results = [];
		open = false;
		active = -1;
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown' && results.length) {
			event.preventDefault();
			open = true;
			active = (active + 1) % results.length;
		} else if (event.key === 'ArrowUp' && results.length) {
			event.preventDefault();
			active = (active - 1 + results.length) % results.length;
		} else if (event.key === 'Enter') {
			event.preventDefault();
			if (open && results[active]) choose(results[active]);
		} else if (event.key === 'Escape' && open) {
			event.preventDefault();
			event.stopPropagation();
			open = false;
		}
	}

	// Searching again when the filters change keeps the list honest.
	$effect(() => {
		format; commander; legal;
		if (query.trim().length >= 2) onInput();
	});
</script>

<div class="relative">
	<label class="block text-sm">
		<span class="text-[var(--color-text-muted)]">{label}</span>
		<input
			type="text"
			role="combobox"
			aria-expanded={open && results.length > 0}
			aria-controls={listId}
			aria-autocomplete="list"
			aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
			autocomplete="off"
			bind:value={query}
			oninput={onInput}
			onkeydown={onKeydown}
			onblur={() => setTimeout(() => (open = false), 150)}
			onfocus={() => { if (results.length) open = true; }}
			{placeholder}
			{disabled}
			class="control mt-1 block w-full px-3 text-sm focus:border-[var(--color-primary)] focus:outline-none"
		/>
	</label>
	{#if open}
		<ul id={listId} role="listbox" aria-label="{label} suggestions" class="absolute left-0 right-0 z-30 mt-1 max-h-72 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] py-1 shadow-xl">
			{#each results as card, i (card.id)}
				<li
					id="{listId}-{i}"
					role="option"
					aria-selected={i === active}
					class="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm {i === active ? 'bg-white/10' : 'hover:bg-white/5'}"
					onmousedown={(e) => { e.preventDefault(); choose(card); }}
					onmouseenter={() => (active = i)}
				>
					<span class="min-w-0 flex-1 truncate">{card.name}</span>
					<ManaCost cost={card.mana_cost} class="shrink-0" />
					<span class="set-code shrink-0 text-[0.65rem] uppercase text-[var(--color-text-faint)]">{card.set_code}</span>
				</li>
			{:else}
				<li class="px-3 py-2 text-sm text-[var(--color-text-muted)]">{loading ? 'Searching…' : 'No matching card.'}</li>
			{/each}
		</ul>
	{/if}
</div>
