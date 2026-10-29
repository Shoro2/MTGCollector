<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import ColorPips from './ColorPips.svelte';
	import DeckBracket from './DeckBracket.svelte';
	import { DECK_FORMATS, deckFormat } from '$lib/deck-formats';
	import { timeAgo, type Visibility } from '$lib/deck';
	import { formatPrice } from '$lib/utils';

	type Summary = {
		id: string; name: string; format: string; visibility: Visibility; bracket: number | null; updated_at: string;
		cards: number; sideboard: number; value: number; unpriced: number; colors: string[]; commander: { name: string } | null;
	};
	/** Everybody's public decks: searched, filtered, sorted and paged on the server (URL parameters). */
	let { list }: { list: { decks: Summary[]; total: number; page: number; pages: number; q: string; format: string; sort: string } } = $props();

	const SORTS = { updated: 'Recently updated', name: 'Name', cards: 'Most cards' } as const;
	let search = $state('');
	$effect(() => { search = list.q; });

	function href(changes: Record<string, string | number>) {
		const params = new URLSearchParams(page.url.searchParams);
		params.set('view', 'public');
		for (const [key, value] of Object.entries(changes)) {
			if (value && !(key === 'page' && value === 1) && !(key === 'sort' && value === 'updated')) params.set(key, String(value));
			else params.delete(key);
		}
		return `/decks?${params}`;
	}
	const navigate = (changes: Record<string, string | number>) => goto(href({ page: 1, ...changes }), { keepFocus: true, noScroll: true });
</script>

<div class="toolbar flex-wrap">
	<form onsubmit={(e) => { e.preventDefault(); navigate({ q: search.trim() }); }} class="flex min-w-0 basis-full gap-2 sm:basis-0 sm:flex-1">
		<input type="search" bind:value={search} placeholder="Search deck names or commanders…" aria-label="Search public decks" class="control min-w-0 flex-1 px-3 text-sm" />
		<button type="submit" class="btn">Search</button>
	</form>
	<label class="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
		Format
		<select aria-label="Format" value={list.format} onchange={(e) => navigate({ format: e.currentTarget.value })} class="control px-2 text-sm">
			<option value="">All formats</option>
			{#each DECK_FORMATS as f (f.key)}<option value={f.key}>{f.label}</option>{/each}
		</select>
	</label>
	<label class="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
		Sort
		<select aria-label="Sort public decks" value={list.sort} onchange={(e) => navigate({ sort: e.currentTarget.value })} class="control px-2 text-sm">
			{#each Object.entries(SORTS) as [value, label] (value)}<option {value}>{label}</option>{/each}
		</select>
	</label>
</div>

<p class="text-sm text-[var(--color-text-muted)]" data-public-total={list.total}>
	{list.total === 1 ? '1 public deck' : `${list.total} public decks`}{list.q ? ` matching "${list.q}"` : ''}.
	Decks show their list only, never who made them.
</p>

{#if list.decks.length}
	<div class="panel overflow-hidden">
		<table class="w-full text-sm" data-public-decks>
			<thead class="text-left text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
				<tr class="border-b border-[var(--color-border)]">
					<th class="px-4 py-3">Deck</th>
					<th class="hidden px-3 py-3 sm:table-cell">Colors</th>
					<th class="hidden px-3 py-3 md:table-cell">Format</th>
					<th class="hidden px-3 py-3 text-right lg:table-cell">Cards</th>
					<th class="px-3 py-3 text-right">Value</th>
					<th class="hidden px-4 py-3 text-right sm:table-cell">Updated</th>
				</tr>
			</thead>
			<tbody>
				{#each list.decks as deck (deck.id)}
					<tr class="border-b border-[var(--color-border-subtle)] last:border-0">
						<td class="px-4 py-3">
							<a href="/decks/{deck.id}" class="font-medium text-[var(--color-text)] hover:text-[var(--color-primary)]">{deck.name}</a>
							{#if deckFormat(deck.format).kind === 'commander'}<DeckBracket bracket={deck.bracket} compact />{/if}
							<p class="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">
								{#if deck.commander}{deck.commander.name}{/if}
								<span class="md:hidden">{deck.commander ? ' · ' : ''}{deckFormat(deck.format).label}</span>
							</p>
						</td>
						<td class="hidden px-3 py-3 sm:table-cell"><ColorPips colors={deck.colors} includeColorless /></td>
						<td class="hidden px-3 py-3 text-[var(--color-text-muted)] md:table-cell">{deckFormat(deck.format).label}</td>
						<td class="tabular hidden px-3 py-3 text-right lg:table-cell">{deck.cards}{#if deck.sideboard}<span class="text-[var(--color-text-faint)]"> + {deck.sideboard}</span>{/if}</td>
						<td class="price px-3 py-3 text-right text-[var(--color-accent)]">{formatPrice(deck.value)}</td>
						<td class="hidden px-4 py-3 text-right text-[var(--color-text-muted)] sm:table-cell" title={new Date(deck.updated_at).toLocaleString()}>{timeAgo(deck.updated_at)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if list.pages > 1}
		<nav class="flex items-center justify-between gap-3 text-sm" aria-label="Public deck pages">
			{#if list.page > 1}<a href={href({ page: list.page - 1 })} rel="prev" class="btn">Previous</a>{:else}<span></span>{/if}
			<span class="text-[var(--color-text-muted)]">Page {list.page} of {list.pages}</span>
			{#if list.page < list.pages}<a href={href({ page: list.page + 1 })} rel="next" class="btn">Next</a>{:else}<span></span>{/if}
		</nav>
	{/if}
{:else}
	<div class="panel p-8 text-center text-[var(--color-text-muted)]">
		{list.q || list.format ? 'No public deck matches.' : 'Nobody has shared a public deck yet.'}
	</div>
{/if}
