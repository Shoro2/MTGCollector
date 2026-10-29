<script lang="ts">
	import type { PageData } from './$types';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import ColorPips from '$lib/components/ColorPips.svelte';
	import DeckBracket from '$lib/components/DeckBracket.svelte';
	import DeckCreate from '$lib/components/DeckCreate.svelte';
	import PublicDeckList from '$lib/components/PublicDeckList.svelte';
	import { deckFormat } from '$lib/deck-formats';
	import { VISIBILITY_LABELS, timeAgo } from '$lib/deck';
	import { formatPrice } from '$lib/utils';

	let { data }: { data: PageData } = $props();

	const SORTS = { updated: 'Updated', name: 'Name', format: 'Format', cards: 'Cards', value: 'Value' } as const;
	type Sort = keyof typeof SORTS;
	const sort = $derived((page.url.searchParams.get('sort') as Sort) in SORTS ? (page.url.searchParams.get('sort') as Sort) : 'updated');
	const defaultDir = (s: Sort) => (s === 'name' || s === 'format' ? 'asc' : 'desc');
	const dir = $derived(page.url.searchParams.get('dir') === 'asc' || page.url.searchParams.get('dir') === 'desc' ? page.url.searchParams.get('dir')! : defaultDir(sort));
	const q = $derived(page.url.searchParams.get('q') ?? '');
	let search = $state('');
	$effect(() => { search = q; });
	let creating = $state(false);

	const decks = $derived.by(() => {
		const needle = q.trim().toLowerCase();
		const list = data.decks.filter((d) => !needle || d.name.toLowerCase().includes(needle) || d.commander?.name.toLowerCase().includes(needle));
		const key = (d: (typeof list)[number]): string | number =>
			sort === 'name' ? d.name.toLowerCase() : sort === 'format' ? deckFormat(d.format).label : sort === 'cards' ? d.cards : sort === 'value' ? d.value : d.updated_at;
		return [...list].sort((a, b) => {
			const [x, y] = [key(a), key(b)];
			const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
			return (dir === 'asc' ? order : -order) || a.name.localeCompare(b.name);
		});
	});

	function navigate(changes: Record<string, string>) {
		const params = new URLSearchParams(page.url.searchParams);
		for (const [key, value] of Object.entries(changes)) {
			if (value) params.set(key, value);
			else params.delete(key);
		}
		goto(`/decks${params.size ? `?${params}` : ''}`, { replaceState: true, keepFocus: true, noScroll: true });
	}

	function sortBy(next: Sort) {
		navigate({ sort: next === 'updated' ? '' : next, dir: sort === next ? (dir === 'asc' ? 'desc' : 'asc') : '' });
	}
	const indicator = (s: Sort) => (sort === s ? (dir === 'asc' ? ' ▲' : ' ▼') : '');
	const ariaSort = (s: Sort) => (sort === s ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
</script>

<svelte:head>
	<title>Decks | MTG Collector</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="space-y-5">
	<div class="page-heading">
		<div>
			<p class="eyebrow">Deck building</p>
			<h1 class="mt-1 text-[22px] font-semibold text-[var(--color-text-strong)]">{data.view === 'public' ? 'Public decks' : 'Your decks'}</h1>
		</div>
		{#if data.signedIn}
			<button type="button" onclick={() => (creating = true)} class="btn btn-primary">New deck</button>
		{:else}
			<a href="/login" class="btn btn-primary">Sign in to build decks</a>
		{/if}
	</div>

	{#if data.signedIn}
		<nav class="flex gap-1 border-b border-[var(--color-border)] text-sm" aria-label="Deck lists">
			{#each [['mine', 'Your decks', '/decks'], ['public', 'Public decks', '/decks?view=public']] as [key, label, href] (key)}
				<a
					{href}
					aria-current={data.view === key ? 'page' : undefined}
					class="-mb-px border-b-2 px-3 py-2 {data.view === key ? 'border-[var(--color-primary)] text-[var(--color-text-strong)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}"
				>{label}</a>
			{/each}
		</nav>
	{/if}

	{#if data.public}
		<PublicDeckList list={data.public} />
	{:else if data.decks.length === 0}
		<div class="panel p-8 text-center">
			<p class="text-[var(--color-text-muted)]">You have no decks yet.</p>
			<p class="mt-1 text-sm text-[var(--color-text-muted)]">Create one from scratch or paste a list from Moxfield, MTG Arena or MTGO.</p>
			<button type="button" onclick={() => (creating = true)} class="btn btn-primary mt-4">Create your first deck</button>
		</div>
	{:else}
		<div class="toolbar">
			<form onsubmit={(e) => { e.preventDefault(); navigate({ q: search.trim() }); }} class="flex min-w-0 basis-full gap-2 sm:basis-0 sm:flex-1">
				<input type="search" bind:value={search} placeholder="Search decks or commanders…" aria-label="Search decks" class="control min-w-0 flex-1 px-3 text-sm" />
				<button type="submit" class="btn">Search</button>
			</form>
			<label class="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
				Sort
				<select aria-label="Sort decks" value={sort} onchange={(e) => navigate({ sort: e.currentTarget.value === 'updated' ? '' : e.currentTarget.value, dir: '' })} class="control px-2 text-sm">
					{#each Object.entries(SORTS) as [value, label] (value)}<option {value}>{label}</option>{/each}
				</select>
			</label>
		</div>

		<p class="text-sm text-[var(--color-text-muted)]">
			Showing {decks.length} of {data.decks.length} {data.decks.length === 1 ? 'deck' : 'decks'}{q ? ` matching "${q}"` : ''}.
		</p>

		<div class="panel overflow-hidden">
			<table class="w-full text-sm">
				<thead class="text-left text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
					<tr class="border-b border-[var(--color-border)]">
						<th class="px-4 py-3" aria-sort={ariaSort('name')}><button type="button" onclick={() => sortBy('name')}>Name{indicator('name')}</button></th>
						<th class="hidden px-3 py-3 sm:table-cell">Colors</th>
						<th class="hidden px-3 py-3 md:table-cell" aria-sort={ariaSort('format')}><button type="button" onclick={() => sortBy('format')}>Format{indicator('format')}</button></th>
						<th class="hidden px-3 py-3 text-right lg:table-cell" aria-sort={ariaSort('cards')}><button type="button" onclick={() => sortBy('cards')}>Cards{indicator('cards')}</button></th>
						<th class="px-3 py-3 text-right" aria-sort={ariaSort('value')}><button type="button" onclick={() => sortBy('value')}>Value{indicator('value')}</button></th>
						<th class="hidden px-4 py-3 text-right sm:table-cell" aria-sort={ariaSort('updated')}><button type="button" onclick={() => sortBy('updated')}>Updated{indicator('updated')}</button></th>
					</tr>
				</thead>
				<tbody>
					{#each decks as deck (deck.id)}
						<tr class="border-b border-[var(--color-border-subtle)] last:border-0">
							<td class="px-4 py-3">
								<a href="/decks/{deck.id}" class="font-medium text-[var(--color-text)] hover:text-[var(--color-primary)]">{deck.name}</a>
								{#if deckFormat(deck.format).kind === 'commander'}<DeckBracket bracket={deck.bracket} compact />{/if}
								{#if deck.visibility !== 'private'}
									<span class="chip ml-1 min-h-0 px-1.5 py-0 text-[0.62rem] uppercase">{VISIBILITY_LABELS[deck.visibility]}</span>
								{/if}
								<p class="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">
									{#if deck.commander}{deck.commander.name}{/if}
									<span class="md:hidden">{deck.commander ? ' · ' : ''}{deckFormat(deck.format).label}</span>
									<span class="sm:hidden"> · {timeAgo(deck.updated_at)}</span>
								</p>
							</td>
							<td class="hidden px-3 py-3 sm:table-cell"><ColorPips colors={deck.colors} includeColorless /></td>
							<td class="hidden px-3 py-3 text-[var(--color-text-muted)] md:table-cell">{deckFormat(deck.format).label}</td>
							<td class="tabular hidden px-3 py-3 text-right lg:table-cell">{deck.cards}{#if deck.sideboard}<span class="text-[var(--color-text-faint)]"> + {deck.sideboard}</span>{/if}</td>
							<td class="price px-3 py-3 text-right text-[var(--color-accent)]">
								{deck.cards || deck.sideboard ? formatPrice(deck.value) : '-'}
								{#if deck.unpriced}<span class="block text-[0.65rem] text-[var(--color-text-faint)]" title="Copies without a price are not counted">{deck.unpriced} unpriced</span>{/if}
							</td>
							<td class="hidden px-4 py-3 text-right text-[var(--color-text-muted)] sm:table-cell" title={new Date(deck.updated_at).toLocaleString()}>{timeAgo(deck.updated_at)}</td>
						</tr>
					{:else}
						<tr><td colspan="6" class="px-4 py-6 text-center text-[var(--color-text-muted)]">No deck matches "{q}".</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

{#if creating}
	<DeckCreate authorName={data.create?.authorName ?? ''} captchaSiteKey={data.create?.captchaSiteKey ?? null} publishBlocked={data.create?.publishBlocked ?? null} onclose={() => (creating = false)} />
{/if}
