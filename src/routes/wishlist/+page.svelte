<script lang="ts">
	import type { PageData } from './$types';
	import { goto, invalidate } from '$app/navigation';
	import { formatPrice, scryfallSrcset } from '$lib/utils';
	import CardPreview from '$lib/components/CardPreview.svelte';
	import ManaCost from '$lib/components/ManaCost.svelte';

	let { data }: { data: PageData } = $props();

	let search = $state('');
	$effect(() => { search = data.filters.search; });
	let removing = $state<number | null>(null);
	let adding = $state<string | null>(null);
	let collectingItem = $state<{ cardId: string; wishlistId: number } | null>(null);
	let collectPrice = $state('');

	const collectedSet = $derived(new Set(data.collectedCardIds));

	function doSearch() {
		const params = new URLSearchParams();
		if (search) params.set('q', search);
		if (data.filters.sortBy !== 'added_at') params.set('sort', data.filters.sortBy);
		if (data.filters.sortDir !== 'desc') params.set('dir', data.filters.sortDir);
		goto(`/wishlist?${params.toString()}`);
	}

	function sort(field: string) {
		const params = new URLSearchParams(window.location.search);
		if (data.filters.sortBy === field) {
			params.set('dir', data.filters.sortDir === 'asc' ? 'desc' : 'asc');
		} else {
			params.set('sort', field);
			params.set('dir', field === 'name' ? 'asc' : 'desc');
		}
		goto(`/wishlist?${params.toString()}`);
	}

	function sortIndicator(field: string): string {
		if (data.filters.sortBy !== field) return '';
		return data.filters.sortDir === 'asc' ? ' \u25B2' : ' \u25BC';
	}

	async function removeFromWishlist(id: number) {
		removing = id;
		await fetch('/wishlist', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id })
		});
		removing = null;
		await invalidate('app:wishlist');
	}

	function startCollect(cardId: string, wishlistId: number) {
		collectingItem = { cardId, wishlistId };
		collectPrice = '';
	}

	async function confirmCollect() {
		if (!collectingItem) return;
		adding = collectingItem.cardId;
		const purchasePrice = collectPrice.trim() ? parseFloat(collectPrice) : null;
		await fetch('/collection', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ cardId: collectingItem.cardId, quantity: 1, condition: 'near_mint', foil: false, purchasePrice })
		});
		await fetch('/wishlist', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: collectingItem.wishlistId })
		});
		adding = null;
		collectingItem = null;
		await invalidate('app:wishlist');
	}

	function getImageSrc(item: Record<string, unknown>): string {
		if (item.local_image_path) return item.local_image_path as string;
		if (item.image_uri) return item.image_uri as string;
		return '';
	}
</script>

<svelte:head>
	<title>Wishlist | MTG Collector</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="space-y-5">
	<div class="page-heading">
		<div>
			<p class="eyebrow">Planning</p>
			<h1 class="mt-1 text-[22px] font-semibold text-[var(--color-text-strong)]">Wishlist</h1>
		</div>
		<span class="chip tabular">{data.items.length} cards</span>
	</div>

	<!-- Search & Sort -->
	<div class="toolbar">
		<form onsubmit={(e) => { e.preventDefault(); doSearch(); }} class="flex-1 flex gap-2">
			<input
				type="text"
				bind:value={search}
				placeholder="Search wishlist..."
				class="control flex-1 min-w-0 px-3 text-sm focus:outline-none focus:border-[var(--color-primary)]"
			/>
			<button type="submit" class="btn btn-primary">
				Search
			</button>
		</form>
		<div class="flex flex-wrap gap-2">
			<button onclick={() => sort('name')} class="btn min-h-8 {data.filters.sortBy === 'name' ? 'btn-primary' : ''}">
				Name{sortIndicator('name')}
			</button>
			<button onclick={() => sort('added_at')} class="btn min-h-8 {data.filters.sortBy === 'added_at' ? 'btn-primary' : ''}">
				Date{sortIndicator('added_at')}
			</button>
			<button onclick={() => sort('price')} class="btn min-h-8 {data.filters.sortBy === 'price' ? 'btn-primary' : ''}">
				Price{sortIndicator('price')}
			</button>
			<button onclick={() => sort('priority')} class="btn min-h-8 {data.filters.sortBy === 'priority' ? 'btn-primary' : ''}">
				Priority{sortIndicator('priority')}
			</button>
		</div>
	</div>

	<!-- Cards -->
	{#if data.items.length === 0}
		<div class="panel p-8 text-center">
			<p class="text-[var(--color-text-muted)]">Your wishlist is empty.</p>
			<a href="/cards" class="text-[var(--color-primary)] hover:underline text-sm mt-2 inline-block">Browse cards to add some</a>
		</div>
	{:else}
		<div class="space-y-2">
			{#each data.items as item (item.id)}
				{@const imgSrc = getImageSrc(item)}
				{@const srcset = item.local_image_path ? null : scryfallSrcset(item.image_uri as string | null)}
				{@const inCollection = collectedSet.has(item.card_id as string)}
				<div class="panel flex items-start gap-3 p-3 transition-colors hover:bg-[var(--color-surface-hover)] sm:items-center sm:gap-4">
					<!-- Card Image -->
					{#if imgSrc}
						<CardPreview src={imgSrc} alt={item.name as string} scale={2.4}>
							<a href="/cards/{item.card_id}">
								<img src={imgSrc} srcset={srcset ?? undefined} sizes="80px" alt={item.name as string} class="w-12 h-16 sm:w-14 sm:h-20 object-cover rounded flex-shrink-0" loading="lazy" />
							</a>
						</CardPreview>
					{/if}

					<div class="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-center sm:gap-4">
						<!-- Card Info -->
						<div class="flex-1 min-w-0">
							<div class="flex flex-wrap items-center gap-2">
								<a href="/cards/{item.card_id}" class="font-semibold hover:text-[var(--color-primary)] transition-colors break-words min-w-0">{item.name}</a>
								{#if inCollection}
									<span class="text-green-400 text-xs flex-shrink-0" title="In collection">&#10003; owned</span>
								{/if}
								{#if (item.priority as number) > 0}
									<span class="text-xs px-1.5 py-0.5 rounded bg-yellow-600/20 text-yellow-400 flex-shrink-0">
										{'!'.repeat(Math.min(item.priority as number, 3))}
									</span>
								{/if}
							</div>
							<p class="text-sm text-[var(--color-text-muted)] truncate">
								{item.set_name}
								{#if item.mana_cost}
									<span class="ml-2 inline-flex align-middle"><ManaCost cost={item.mana_cost as string} /></span>
								{/if}
							</p>
							{#if item.notes}
								<p class="text-xs text-[var(--color-text-muted)] mt-0.5 italic truncate">{item.notes}</p>
							{/if}
						</div>

						<div class="flex items-center justify-between sm:justify-end gap-3 mt-2 sm:mt-0 flex-wrap">
							<!-- Price -->
							<div class="text-left sm:text-right flex-shrink-0">
								<p class="text-[var(--color-accent)] font-medium">
									{formatPrice(item.price_eur as number | null, item.price_usd as number | null)}
								</p>
							</div>

							<!-- Actions -->
							<div class="flex items-center gap-2 flex-shrink-0 flex-wrap">
						{#if !inCollection}
							{#if collectingItem?.cardId === item.card_id}
								<form onsubmit={(e) => { e.preventDefault(); confirmCollect(); }} class="flex items-center gap-1.5">
									<span class="text-xs text-[var(--color-text-muted)]">€</span>
									<input
										type="number"
										step="0.01"
										min="0"
										bind:value={collectPrice}
										placeholder="Price"
										class="w-20 bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-xs focus:outline-none focus:border-[var(--color-primary)]"
									/>
									<button
										type="submit"
										disabled={adding === item.card_id}
										class="bg-green-600 hover:bg-green-700 px-2 py-1 rounded text-xs transition-colors disabled:opacity-50"
									>
										{adding === item.card_id ? '...' : 'OK'}
									</button>
									<button
										type="button"
										onclick={() => collectingItem = null}
										class="text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-1 py-1 text-xs"
									>
										✕
									</button>
								</form>
							{:else}
								<button
									onclick={() => startCollect(item.card_id as string, item.id as number)}
									class="bg-green-600 hover:bg-green-700 px-3 py-1.5 rounded-lg text-xs transition-colors"
									title="Add to collection & remove from wishlist"
								>
									Collect
								</button>
							{/if}
						{/if}
							<button
								onclick={() => removeFromWishlist(item.id as number)}
								disabled={removing === item.id}
								class="text-red-400 hover:text-red-300 px-2 py-1.5 rounded-lg text-xs transition-colors disabled:opacity-50"
								title="Remove from wishlist"
							>
								{removing === item.id ? '...' : '✕'}
							</button>
							</div>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
