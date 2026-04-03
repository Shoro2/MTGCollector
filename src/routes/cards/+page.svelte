<script lang="ts">
	import type { PageData } from './$types';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { formatManaCost, formatPrice, getRarityColor } from '$lib/utils';
	import CardPreview from '$lib/components/CardPreview.svelte';

	let { data }: { data: PageData } = $props();
	let collectedSet = $derived(new Set(data.collectedCardIds));

	let query = $state('');
	let selectedColors = $state<string[]>([]);
	let colorMode = $state('include');
	let type = $state('');
	let setCode = $state('');
	let rarity = $state('');
	let cmcMin = $state('');
	let cmcMax = $state('');
	let legality = $state('');

	$effect(() => {
		query = data.filters.query;
		selectedColors = data.filters.colors;
		colorMode = data.filters.colorMode;
		type = data.filters.type;
		setCode = data.filters.setCode;
		rarity = data.filters.rarity;
		cmcMin = data.filters.cmcMin || '';
		cmcMax = data.filters.cmcMax || '';
		legality = data.filters.legality;
	});
	let showFilters = $state(false);

	const colors = [
		{ code: 'W', name: 'White', bg: 'bg-yellow-100', text: 'text-yellow-800' },
		{ code: 'U', name: 'Blue', bg: 'bg-blue-400', text: 'text-blue-900' },
		{ code: 'B', name: 'Black', bg: 'bg-gray-700', text: 'text-gray-100' },
		{ code: 'R', name: 'Red', bg: 'bg-red-500', text: 'text-red-100' },
		{ code: 'G', name: 'Green', bg: 'bg-green-500', text: 'text-green-100' }
	];

	const rarities = ['common', 'uncommon', 'rare', 'mythic'];
	const legalities = ['standard', 'modern', 'legacy', 'vintage', 'commander', 'pioneer', 'pauper'];
	const types = ['Creature', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Planeswalker', 'Land'];

	function toggleColor(code: string) {
		if (selectedColors.includes(code)) {
			selectedColors = selectedColors.filter((c) => c !== code);
		} else {
			selectedColors = [...selectedColors, code];
		}
	}

	function search() {
		const params = new URLSearchParams();
		if (query) params.set('q', query);
		for (const c of selectedColors) params.append('color', c);
		if (selectedColors.length > 0) params.set('colorMode', colorMode);
		if (type) params.set('type', type);
		if (setCode) params.set('set', setCode);
		if (rarity) params.set('rarity', rarity);
		if (cmcMin) params.set('cmcMin', cmcMin);
		if (cmcMax) params.set('cmcMax', cmcMax);
		if (legality) params.set('legality', legality);
		goto(`/cards?${params.toString()}`);
	}

	function goToPage(p: number) {
		const params = new URLSearchParams($page.url.searchParams);
		params.set('page', p.toString());
		goto(`/cards?${params.toString()}`);
	}

	function setSort(sort: string) {
		const params = new URLSearchParams($page.url.searchParams);
		if (data.filters.sortBy === sort) {
			params.set('dir', data.filters.sortDir === 'asc' ? 'desc' : 'asc');
		} else {
			params.set('sort', sort);
			params.set('dir', 'asc');
		}
		params.delete('page');
		goto(`/cards?${params.toString()}`);
	}

	function toggleUnique() {
		const params = new URLSearchParams($page.url.searchParams);
		if (data.filters.unique) {
			params.delete('unique');
		} else {
			params.set('unique', '1');
		}
		params.delete('page');
		goto(`/cards?${params.toString()}`);
	}

	function clearFilters() {
		query = '';
		selectedColors = [];
		colorMode = 'include';
		type = '';
		setCode = '';
		rarity = '';
		cmcMin = '';
		cmcMax = '';
		legality = '';
		goto('/cards');
	}

	function getImageSrc(card: Record<string, unknown>): string {
		if (card.local_image_path) return card.local_image_path as string;
		if (card.image_uri) return card.image_uri as string;
		return '';
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold">Browse Cards</h1>
		<span class="text-[var(--color-text-muted)]">{data.totalCards.toLocaleString()} results</span>
	</div>

	<!-- Search Bar -->
	<form onsubmit={(e) => { e.preventDefault(); search(); }} class="flex gap-2">
		<input
			type="text"
			bind:value={query}
			placeholder="Search cards by name or text..."
			class="flex-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg px-4 py-2 text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-primary)]"
		/>
		<button
			type="submit"
			class="bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] px-6 py-2 rounded-lg font-medium transition-colors"
		>
			Search
		</button>
		<button
			type="button"
			onclick={() => showFilters = !showFilters}
			class="bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] px-4 py-2 rounded-lg border border-[var(--color-border)] transition-colors"
		>
			Filters {showFilters ? '▲' : '▼'}
		</button>
	</form>

	<!-- Filters Panel -->
	{#if showFilters}
		<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)] space-y-4">
			<!-- Colors -->
			<div>
				<span class="block text-sm text-[var(--color-text-muted)] mb-2">Colors</span>
				<div class="flex gap-2 items-center">
					{#each colors as color}
						<button
							onclick={() => toggleColor(color.code)}
							class="w-10 h-10 rounded-full flex items-center justify-center font-bold text-lg transition-all {color.bg} {color.text} {selectedColors.includes(color.code) ? 'ring-2 ring-white scale-110' : 'opacity-50'}"
						>
							{color.code}
						</button>
					{/each}
					{#if selectedColors.length > 0}
						<select bind:value={colorMode} class="ml-4 bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-sm">
							<option value="include">Include these</option>
							<option value="exact">Exactly these</option>
							<option value="at_most">At most these</option>
						</select>
					{/if}
				</div>
			</div>

			<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
				<!-- Type -->
				<div>
					<label for="filter-type" class="block text-sm text-[var(--color-text-muted)] mb-1">Type</label>
					<select id="filter-type" bind:value={type} class="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1.5">
						<option value="">All Types</option>
						{#each types as t}
							<option value={t}>{t}</option>
						{/each}
					</select>
				</div>

				<!-- Set -->
				<div>
					<label for="filter-set" class="block text-sm text-[var(--color-text-muted)] mb-1">Set</label>
					<select id="filter-set" bind:value={setCode} class="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1.5">
						<option value="">All Sets</option>
						{#each data.sets as s}
							<option value={s.set_code}>{s.set_name}</option>
						{/each}
					</select>
				</div>

				<!-- Rarity -->
				<div>
					<label for="filter-rarity" class="block text-sm text-[var(--color-text-muted)] mb-1">Rarity</label>
					<select id="filter-rarity" bind:value={rarity} class="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1.5">
						<option value="">All Rarities</option>
						{#each rarities as r}
							<option value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
						{/each}
					</select>
				</div>

				<!-- Legality -->
				<div>
					<label for="filter-legality" class="block text-sm text-[var(--color-text-muted)] mb-1">Legal in</label>
					<select id="filter-legality" bind:value={legality} class="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1.5">
						<option value="">Any Format</option>
						{#each legalities as l}
							<option value={l}>{l.charAt(0).toUpperCase() + l.slice(1)}</option>
						{/each}
					</select>
				</div>
			</div>

			<!-- CMC Range -->
			<div class="flex gap-4 items-center">
				<span class="text-sm text-[var(--color-text-muted)]">CMC</span>
				<input
					type="number"
					bind:value={cmcMin}
					placeholder="Min"
					min="0"
					class="w-20 bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1"
				/>
				<span class="text-[var(--color-text-muted)]">to</span>
				<input
					type="number"
					bind:value={cmcMax}
					placeholder="Max"
					min="0"
					class="w-20 bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1"
				/>
			</div>

			<div class="flex gap-2">
				<button onclick={search} class="bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] px-4 py-2 rounded-lg text-sm transition-colors">
					Apply Filters
				</button>
				<button onclick={clearFilters} class="text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-4 py-2 text-sm transition-colors">
					Clear All
				</button>
			</div>
		</div>
	{/if}

	<!-- Sort Bar -->
	<div class="flex items-center gap-2 text-sm flex-wrap">
		<span class="text-[var(--color-text-muted)]">Sort by:</span>
		{#each [['name', 'Name'], ['price', 'Price'], ['cmc', 'CMC'], ['rarity', 'Rarity'], ['set', 'Set'], ['released', 'Released']] as [key, label]}
			<button
				onclick={() => setSort(key)}
				class="px-3 py-1 rounded-lg border transition-colors {data.filters.sortBy === key ? 'bg-[var(--color-primary)] border-[var(--color-primary)] text-white' : 'bg-[var(--color-surface)] border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]'}"
			>
				{label}
				{#if data.filters.sortBy === key}
					{data.filters.sortDir === 'asc' ? '▲' : '▼'}
				{/if}
			</button>
		{/each}
		<span class="mx-2 text-[var(--color-border)]">|</span>
		<button
			onclick={toggleUnique}
			class="px-3 py-1 rounded-lg border transition-colors {data.filters.unique ? 'bg-[var(--color-primary)] border-[var(--color-primary)] text-white' : 'bg-[var(--color-surface)] border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]'}"
		>
			Unique only
		</button>
	</div>

	<!-- Card Grid -->
	<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
		{#each data.cards as card}
			{@const imgSrc = getImageSrc(card)}
			{@const inCollection = collectedSet.has(card.id as string)}
			<a
				href="/cards/{card.id}"
				class="group bg-[var(--color-surface)] rounded-lg overflow-hidden border transition-all hover:scale-[1.02] {inCollection ? 'border-green-500/50' : 'border-[var(--color-border)] hover:border-[var(--color-primary)]'}"
			>
				<div class="relative">
					{#if imgSrc}
						<CardPreview src={imgSrc} alt={card.name as string} scale={2}>
							<img
								src={imgSrc}
								alt={card.name as string}
								class="w-full aspect-[488/680] object-cover"
								loading="lazy"
							/>
						</CardPreview>
					{:else}
						<div class="w-full aspect-[488/680] bg-[var(--color-bg)] flex items-center justify-center text-[var(--color-text-muted)] text-sm p-4 text-center">
							{card.name}
						</div>
					{/if}
					{#if inCollection}
						<div class="absolute top-1.5 right-1.5 bg-green-500 rounded-full w-6 h-6 flex items-center justify-center shadow-lg">
							<svg class="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
								<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
							</svg>
						</div>
					{/if}
				</div>
				<div class="p-2">
					<p class="text-sm font-medium truncate">{card.name}</p>
					<div class="flex items-center justify-between mt-1">
						<span class="text-xs text-[var(--color-text-muted)]">{card.set_name}</span>
						{#if card.price_eur}
							<span class="text-xs text-[var(--color-accent)]">{formatPrice(card.price_eur as number)}</span>
						{/if}
					</div>
				</div>
			</a>
		{/each}
	</div>

	{#if data.cards.length === 0}
		<div class="text-center py-12 text-[var(--color-text-muted)]">
			<p class="text-lg">No cards found.</p>
			<p class="text-sm mt-2">Try adjusting your search or filters.</p>
		</div>
	{/if}

	<!-- Pagination -->
	{#if data.totalPages > 1}
		<div class="flex items-center justify-center gap-2">
			<button
				onclick={() => goToPage(data.page - 1)}
				disabled={data.page <= 1}
				class="px-3 py-1.5 rounded bg-[var(--color-surface)] border border-[var(--color-border)] disabled:opacity-30 hover:bg-[var(--color-surface-hover)] transition-colors"
			>
				Prev
			</button>
			<span class="text-[var(--color-text-muted)] px-4">
				Page {data.page} of {data.totalPages}
			</span>
			<button
				onclick={() => goToPage(data.page + 1)}
				disabled={data.page >= data.totalPages}
				class="px-3 py-1.5 rounded bg-[var(--color-surface)] border border-[var(--color-border)] disabled:opacity-30 hover:bg-[var(--color-surface-hover)] transition-colors"
			>
				Next
			</button>
		</div>
	{/if}
</div>
