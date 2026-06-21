<script lang="ts">
	import type { PageData } from './$types';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { formatPrice, scryfallSrcset } from '$lib/utils';
	import CardPreview from '$lib/components/CardPreview.svelte';

	let { data }: { data: PageData } = $props();
	let collectedSet = $derived(new Set(data.collectedCardIds));
	let wishlistSet = $derived(new Set(data.wishlistCardIds));

	let setSearch = $state('');
	let setDropdownOpen = $state(false);
	let setHighlight = $state(0);
	let setInputEl: HTMLInputElement | null = $state(null);
	let setWrapperEl: HTMLDivElement | null = $state(null);

	let filteredSets = $derived.by(() => {
		const q = setSearch.trim().toLowerCase();
		if (!q) return data.sets;
		return data.sets.filter(
			(s) =>
				s.set_name.toLowerCase().includes(q) ||
				s.set_code.toLowerCase().includes(q)
		);
	});

	function selectSet(code: string, name: string) {
		setCode = code;
		setSearch = name;
		setDropdownOpen = false;
		search();
	}

	function clearSet() {
		setCode = '';
		setSearch = '';
		setDropdownOpen = false;
	}

	function onSetKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			setDropdownOpen = true;
			setHighlight = Math.min(setHighlight + 1, filteredSets.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			setHighlight = Math.max(setHighlight - 1, 0);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const target = filteredSets[setHighlight];
			if (target) selectSet(target.set_code, target.set_name);
		} else if (e.key === 'Escape') {
			setDropdownOpen = false;
		}
	}

	function onDocClick(e: MouseEvent) {
		if (setWrapperEl && !setWrapperEl.contains(e.target as Node)) {
			setDropdownOpen = false;
		}
	}

	$effect(() => {
		document.addEventListener('mousedown', onDocClick);
		return () => document.removeEventListener('mousedown', onDocClick);
	});

	let pageTitle = $derived.by(() => {
		const parts = ['MTG Cards'];
		if (data.filters.query) parts.push(`"${data.filters.query}"`);
		if (data.filters.setCode) parts.push(data.filters.setCode.toUpperCase());
		if (data.page > 1) parts.push(`Page ${data.page}`);
		return parts.join(' - ') + ' | MTG Collector';
	});

	let query = $state('');
	let selectedColors = $state<string[]>([]);
	let colorMode = $state('include');
	let type = $state('');
	let setCode = $state('');
	let rarity = $state('');
	let cmcMin = $state('');
	let cmcMax = $state('');
	let legality = $state('');
	let showFilters = $state(false);

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
		const matched = data.sets.find((s) => s.set_code === data.filters.setCode);
		setSearch = matched ? matched.set_name : '';
	});

	const colors = [
		{ code: 'W', name: 'White' },
		{ code: 'U', name: 'Blue' },
		{ code: 'B', name: 'Black' },
		{ code: 'R', name: 'Red' },
		{ code: 'G', name: 'Green' }
	];

	const rarities = ['common', 'uncommon', 'rare', 'mythic'];
	const legalities = ['standard', 'modern', 'legacy', 'vintage', 'commander', 'pioneer', 'pauper'];
	const types = ['Creature', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Planeswalker', 'Land'];
	const sortOptions = [
		['name', 'Name'],
		['price', 'Price'],
		['cmc', 'CMC'],
		['power', 'Power'],
		['toughness', 'Toughness'],
		['rarity', 'Rarity'],
		['set', 'Set'],
		['released', 'Released']
	];

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
		if (data.filters.unique) params.set('unique', '1');
		goto(`/cards?${params.toString()}`);
	}

	function goToPage(p: number) {
		const params = new URLSearchParams(page.url.searchParams);
		params.set('page', p.toString());
		goto(`/cards?${params.toString()}`);
	}

	function setSort(sort: string) {
		const params = new URLSearchParams(page.url.searchParams);
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
		const params = new URLSearchParams(page.url.searchParams);
		if (data.filters.unique) {
			params.delete('unique');
		} else {
			params.set('unique', '1');
		}
		params.delete('page');
		goto(`/cards?${params.toString()}`, { invalidateAll: true });
	}

	function setPageSize(size: string) {
		const params = new URLSearchParams(page.url.searchParams);
		if (size === '40') params.delete('pageSize');
		else params.set('pageSize', size);
		params.delete('page');
		goto(`/cards?${params.toString()}`, { invalidateAll: true });
	}

	function clearFilters() {
		query = '';
		selectedColors = [];
		colorMode = 'include';
		type = '';
		setCode = '';
		setSearch = '';
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

<svelte:head>
	<title>{pageTitle}</title>
	<meta name="description" content="Browse and search {data.totalCards.toLocaleString()} Magic: The Gathering cards. Filter by color, type, set, rarity, mana cost, and format legality." />
	<link rel="canonical" href="https://mtg-collector.com/cards" />
	<meta property="og:title" content={pageTitle} />
	<meta property="og:description" content="Browse and search {data.totalCards.toLocaleString()} Magic: The Gathering cards. Filter by color, type, set, rarity, mana cost, and format legality." />
	<meta property="og:url" content="https://mtg-collector.com/cards" />
</svelte:head>

<div class="space-y-5">
	<div class="page-heading">
		<div>
			<p class="eyebrow">Card database</p>
			<h1 class="mt-1 text-[22px] font-semibold text-[var(--color-text-strong)]">Browse Cards</h1>
			<p class="mt-1 tabular text-xs text-[var(--color-text-muted)]">
				{data.totalCards.toLocaleString()} cards - page {data.page} of {data.totalPages}
			</p>
		</div>
		<span class="chip">{data.cards.length.toLocaleString()} shown</span>
	</div>

	<form onsubmit={(e) => { e.preventDefault(); search(); }} class="toolbar">
		<div class="relative flex min-w-[240px] flex-1 items-center">
			<svg class="pointer-events-none absolute left-3 h-4 w-4 text-[var(--color-text-faint)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
				<circle cx="11" cy="11" r="8"></circle>
				<path d="m21 21-4.3-4.3"></path>
			</svg>
			<input
				type="text"
				bind:value={query}
				placeholder="Search cards by name, type, or text..."
				class="control h-[38px] w-full pl-9 pr-3 text-sm placeholder:text-[var(--color-text-faint)] focus:outline-none focus:border-[var(--color-primary)]"
			/>
		</div>
		<div class="flex items-center gap-1">
			{#each colors as color}
				<button
					type="button"
					onclick={() => toggleColor(color.code)}
					aria-label={color.name}
					class="color-pip pip-{color.code.toLowerCase()} h-[30px] w-[30px] transition-all {selectedColors.includes(color.code) ? 'scale-105 bg-white/10 opacity-100' : selectedColors.length ? 'opacity-45' : 'opacity-100'}"
				>
					{color.code}
				</button>
			{/each}
		</div>
		<button type="submit" class="btn btn-primary">Search</button>
		<button type="button" onclick={() => (showFilters = !showFilters)} class="btn">
			Filters
			<svg class="h-3.5 w-3.5 transition-transform {showFilters ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="m6 9 6 6 6-6"></path>
			</svg>
		</button>
	</form>

	{#if showFilters}
		<section class="panel p-4">
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
				<div>
					<label for="filter-type" class="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Type</label>
					<select id="filter-type" bind:value={type} class="control w-full px-3 text-sm">
						<option value="">All Types</option>
						{#each types as t}
							<option value={t}>{t}</option>
						{/each}
					</select>
				</div>

				<div class="relative" bind:this={setWrapperEl}>
					<label for="filter-set" class="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Set</label>
					<div class="relative">
						<input
							id="filter-set"
							type="text"
							role="combobox"
							aria-autocomplete="list"
							aria-expanded={setDropdownOpen}
							aria-controls="filter-set-listbox"
							bind:this={setInputEl}
							bind:value={setSearch}
							oninput={() => { setDropdownOpen = true; setHighlight = 0; }}
							onfocus={() => { setDropdownOpen = true; }}
							onkeydown={onSetKeydown}
							placeholder="All Sets"
							autocomplete="off"
							class="control w-full px-3 pr-8 text-sm"
						/>
						{#if setSearch}
							<button
								type="button"
								onclick={clearSet}
								aria-label="Clear set filter"
								class="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-white/5 hover:text-[var(--color-text)]"
							>
								x
							</button>
						{/if}
					</div>
					{#if setDropdownOpen && filteredSets.length > 0}
						<ul
							id="filter-set-listbox"
							role="listbox"
							class="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-overlay)] shadow-[var(--shadow-overlay)]"
						>
							{#each filteredSets as s, i (s.set_code)}
								<li
									role="option"
									aria-selected={i === setHighlight}
									onmousedown={(e) => { e.preventDefault(); selectSet(s.set_code, s.set_name); }}
									onmouseenter={() => (setHighlight = i)}
									class="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm {i === setHighlight ? 'bg-white/5' : ''}"
								>
									<span class="truncate">{s.set_name}</span>
									<span class="set-code text-[var(--color-text-muted)]">{s.set_code}</span>
								</li>
							{/each}
						</ul>
					{:else if setDropdownOpen && filteredSets.length === 0}
						<div class="absolute z-20 mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-overlay)] px-3 py-2 text-sm text-[var(--color-text-muted)] shadow-[var(--shadow-overlay)]">
							No sets match.
						</div>
					{/if}
				</div>

				<div>
					<label for="filter-rarity" class="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Rarity</label>
					<select id="filter-rarity" bind:value={rarity} class="control w-full px-3 text-sm">
						<option value="">All Rarities</option>
						{#each rarities as r}
							<option value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
						{/each}
					</select>
				</div>

				<div>
					<label for="filter-legality" class="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Legal in</label>
					<select id="filter-legality" bind:value={legality} class="control w-full px-3 text-sm">
						<option value="">Any Format</option>
						{#each legalities as l}
							<option value={l}>{l.charAt(0).toUpperCase() + l.slice(1)}</option>
						{/each}
					</select>
				</div>
			</div>

			<div class="mt-3 flex flex-wrap items-center gap-3">
				{#if selectedColors.length > 0}
					<select aria-label="Color filter mode" bind:value={colorMode} class="control px-3 text-sm">
						<option value="include">Include selected colors</option>
						<option value="exact">Exactly selected colors</option>
						<option value="at_most">At most selected colors</option>
					</select>
				{/if}
				<label class="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
					<span>CMC</span>
					<input type="number" bind:value={cmcMin} placeholder="Min" min="0" class="control h-8 w-20 px-2 text-sm" />
					<span>to</span>
					<input type="number" bind:value={cmcMax} placeholder="Max" min="0" class="control h-8 w-20 px-2 text-sm" />
				</label>
				<button type="button" onclick={search} class="btn btn-primary min-h-8">Apply</button>
				<button type="button" onclick={clearFilters} class="btn min-h-8">Clear All</button>
			</div>
		</section>
	{/if}

	<div class="flex flex-wrap items-center gap-2">
		<span class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Sort</span>
		<div class="flex flex-wrap gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-1">
			{#each sortOptions as [key, label]}
				<button
					type="button"
					onclick={() => setSort(key)}
					class="rounded-md px-3 py-1.5 text-xs font-semibold transition-colors {data.filters.sortBy === key ? 'bg-[var(--color-primary-button)] text-white' : 'text-[var(--color-text-muted)] hover:bg-white/5 hover:text-[var(--color-text)]'}"
				>
					{label}
					{#if data.filters.sortBy === key}
						{data.filters.sortDir === 'asc' ? 'up' : 'down'}
					{/if}
				</button>
			{/each}
			<button
				type="button"
				onclick={toggleUnique}
				class="rounded-md px-3 py-1.5 text-xs font-semibold transition-colors {data.filters.unique ? 'bg-[var(--color-primary-button)] text-white' : 'text-[var(--color-text-muted)] hover:bg-white/5 hover:text-[var(--color-text)]'}"
			>
				Unique only
			</button>
		</div>
	</div>

	{#if data.cards.length === 0}
		<div class="panel p-10 text-center text-[var(--color-text-muted)]">
			<p class="text-lg font-semibold text-[var(--color-text)]">No cards found.</p>
			<p class="mt-2 text-sm">Try adjusting your search or filters.</p>
		</div>
	{:else}
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
			{#each data.cards as card, i (card.id)}
				{@const imgSrc = getImageSrc(card)}
				{@const srcset = card.local_image_path ? null : scryfallSrcset(card.image_uri as string | null)}
				{@const inCollection = collectedSet.has(card.id as string)}
				{@const onWishlist = wishlistSet.has(card.id as string)}
				<a href="/cards/{card.id}" class="card-shell group no-underline {inCollection ? 'card-shell-owned' : ''}">
					<div class="relative">
						{#if imgSrc}
							<CardPreview src={imgSrc} alt={"Magic: The Gathering - " + (card.name as string)} scale={2}>
								<img
									src={imgSrc}
									srcset={srcset ?? undefined}
									sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 16vw"
									alt="Magic: The Gathering - {card.name}"
									width="488"
									height="680"
									class="aspect-[488/680] w-full object-cover"
									loading={i < 10 ? "eager" : "lazy"}
									fetchpriority={i < 2 ? "high" : "auto"}
								/>
							</CardPreview>
						{:else}
							<div class="card-placeholder p-4 text-sm">
								<span>{card.name}</span>
							</div>
						{/if}
						{#if inCollection}
							<span class="status-badge status-badge-owned">
								Owned
							</span>
						{:else if onWishlist}
							<span class="status-badge status-badge-wish">
								Wish
							</span>
						{/if}
					</div>
					<div class="border-t border-[var(--color-border-subtle)] p-2.5">
						<p class="truncate text-sm font-semibold text-[var(--color-text)]">{card.name}</p>
						<div class="mt-1 flex items-center justify-between gap-2">
							<span class="set-code truncate text-[var(--color-text-muted)]">{card.set_name}</span>
							{#if card.price_eur || card.price_usd}
								<span class="price text-xs font-semibold text-[var(--color-accent)]">{formatPrice(card.price_eur as number | null, card.price_usd as number | null)}</span>
							{/if}
						</div>
					</div>
				</a>
			{/each}
		</div>
	{/if}

	{#if data.totalPages > 1}
		<div class="flex flex-wrap items-center justify-between gap-3">
			<span class="tabular text-xs text-[var(--color-text-muted)]">
				Page {data.page} of {data.totalPages}
			</span>
			<div class="flex items-center gap-2">
				<button onclick={() => goToPage(data.page - 1)} disabled={data.page <= 1} class="btn min-h-8 disabled:cursor-not-allowed disabled:opacity-35">
					Prev
				</button>
				<button onclick={() => goToPage(data.page + 1)} disabled={data.page >= data.totalPages} class="btn min-h-8 disabled:cursor-not-allowed disabled:opacity-35">
					Next
				</button>
				<select
					aria-label="Results per page"
					onchange={(e) => setPageSize((e.target as HTMLSelectElement).value)}
					class="control h-8 px-2 text-sm"
				>
					{#each [40, 75, 100, 200] as size}
						<option value={size} selected={data.filters.pageSize === size}>{size} / page</option>
					{/each}
				</select>
			</div>
		</div>
	{/if}
</div>
