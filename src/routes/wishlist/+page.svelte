<script lang="ts">
	import type { PageData } from './$types';
	import { goto, invalidateAll } from '$app/navigation';
	import { formatPrice, formatManaCost } from '$lib/utils';
	import CardPreview from '$lib/components/CardPreview.svelte';

	let { data }: { data: PageData } = $props();

	let search = $state('');
	$effect(() => { search = data.filters.search; });
	let removing = $state<number | null>(null);
	let adding = $state<string | null>(null);

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
		await invalidateAll();
	}

	async function addToCollection(cardId: string, wishlistId: number) {
		adding = cardId;
		await fetch('/collection', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ cardId, quantity: 1, condition: 'near_mint', foil: false })
		});
		// Remove from wishlist after adding to collection
		await fetch('/wishlist', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: wishlistId })
		});
		adding = null;
		await invalidateAll();
	}

	function getImageSrc(item: Record<string, unknown>): string {
		if (item.local_image_path) return item.local_image_path as string;
		if (item.image_uri) return item.image_uri as string;
		return '';
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold">Wishlist</h1>
		<span class="text-[var(--color-text-muted)] text-sm">{data.items.length} cards</span>
	</div>

	<!-- Search & Sort -->
	<div class="flex gap-2">
		<form onsubmit={(e) => { e.preventDefault(); doSearch(); }} class="flex-1 flex gap-2">
			<input
				type="text"
				bind:value={search}
				placeholder="Search wishlist..."
				class="flex-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-[var(--color-primary)]"
			/>
			<button type="submit" class="bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] px-4 py-2 rounded-lg text-sm transition-colors">
				Search
			</button>
		</form>
		<button onclick={() => sort('name')} class="px-3 py-2 rounded-lg text-sm border transition-colors {data.filters.sortBy === 'name' ? 'bg-[var(--color-primary)] border-[var(--color-primary)]' : 'bg-[var(--color-surface)] border-[var(--color-border)]'}">
			Name{sortIndicator('name')}
		</button>
		<button onclick={() => sort('added_at')} class="px-3 py-2 rounded-lg text-sm border transition-colors {data.filters.sortBy === 'added_at' ? 'bg-[var(--color-primary)] border-[var(--color-primary)]' : 'bg-[var(--color-surface)] border-[var(--color-border)]'}">
			Date{sortIndicator('added_at')}
		</button>
		<button onclick={() => sort('price')} class="px-3 py-2 rounded-lg text-sm border transition-colors {data.filters.sortBy === 'price' ? 'bg-[var(--color-primary)] border-[var(--color-primary)]' : 'bg-[var(--color-surface)] border-[var(--color-border)]'}">
			Price{sortIndicator('price')}
		</button>
		<button onclick={() => sort('priority')} class="px-3 py-2 rounded-lg text-sm border transition-colors {data.filters.sortBy === 'priority' ? 'bg-[var(--color-primary)] border-[var(--color-primary)]' : 'bg-[var(--color-surface)] border-[var(--color-border)]'}">
			Priority{sortIndicator('priority')}
		</button>
	</div>

	<!-- Cards -->
	{#if data.items.length === 0}
		<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-8 text-center">
			<p class="text-[var(--color-text-muted)]">Your wishlist is empty.</p>
			<a href="/cards" class="text-[var(--color-primary)] hover:underline text-sm mt-2 inline-block">Browse cards to add some</a>
		</div>
	{:else}
		<div class="space-y-2">
			{#each data.items as item}
				{@const imgSrc = getImageSrc(item)}
				{@const inCollection = collectedSet.has(item.card_id as string)}
				<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-3 flex items-center gap-4 hover:bg-[var(--color-surface-hover)] transition-colors">
					<!-- Card Image -->
					{#if imgSrc}
						<CardPreview src={imgSrc} alt={item.name as string} scale={2.4}>
							<a href="/cards/{item.card_id}">
								<img src={imgSrc} alt={item.name as string} class="w-14 h-20 object-cover rounded flex-shrink-0" loading="lazy" />
							</a>
						</CardPreview>
					{/if}

					<!-- Card Info -->
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2">
							<a href="/cards/{item.card_id}" class="font-semibold hover:text-[var(--color-primary)] transition-colors truncate">{item.name}</a>
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
								<span class="ml-2">{formatManaCost(item.mana_cost as string)}</span>
							{/if}
						</p>
						{#if item.notes}
							<p class="text-xs text-[var(--color-text-muted)] mt-0.5 italic truncate">{item.notes}</p>
						{/if}
					</div>

					<!-- Price -->
					<div class="text-right flex-shrink-0">
						<p class="text-[var(--color-accent)] font-medium">
							{formatPrice(item.price_eur as number | null, item.price_usd as number | null)}
						</p>
					</div>

					<!-- Actions -->
					<div class="flex items-center gap-2 flex-shrink-0">
						{#if !inCollection}
							<button
								onclick={() => addToCollection(item.card_id as string, item.id as number)}
								disabled={adding === item.card_id}
								class="bg-green-600 hover:bg-green-700 px-3 py-1.5 rounded-lg text-xs transition-colors disabled:opacity-50"
								title="Add to collection & remove from wishlist"
							>
								{adding === item.card_id ? '...' : 'Collect'}
							</button>
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
			{/each}
		</div>
	{/if}
</div>
