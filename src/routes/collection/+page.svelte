<script lang="ts">
	import type { PageData } from './$types';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { formatPrice, conditionLabel } from '$lib/utils';
	import CardPreview from '$lib/components/CardPreview.svelte';

	let { data }: { data: PageData } = $props();

	let search = $state('');
	$effect(() => { search = data.filters.search; });
	let newTagName = $state('');
	let newTagColor = $state('#3b82f6');
	let showTagForm = $state(false);
	let fillingPrices = $state(false);

	// Edit modal state
	let editItemId = $state<number | null>(null);
	let editItem = $derived(
		editItemId !== null
			? data.items.find((i) => i.id === editItemId) ?? data.editCard ?? null
			: null
	);

	// Auto-open edit modal from URL param (e.g. from prices page)
	onMount(() => {
		if (data.editCard) {
			openEdit(data.editCard);
		}
	});

	let editQuantity = $state(1);
	let editCondition = $state('near_mint');
	let editFoil = $state(false);
	let editNotes = $state('');
	let editPurchasePrice = $state('');
	let saving = $state(false);

	function openEdit(item: Record<string, unknown>) {
		editItemId = item.id as number;
		editQuantity = item.quantity as number;
		editCondition = item.condition as string;
		editFoil = !!(item.foil as number);
		editNotes = (item.notes as string) || '';
		editPurchasePrice = item.purchase_price != null ? String(item.purchase_price) : '';
	}

	function closeEdit() {
		editItemId = null;
	}

	async function saveEdit() {
		if (!editItem) return;
		saving = true;
		await fetch('/collection', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				id: editItem.id,
				quantity: editQuantity,
				condition: editCondition,
				foil: editFoil,
				notes: editNotes || null,
				purchasePrice: editPurchasePrice ? parseFloat(editPurchasePrice) : null
			})
		});
		saving = false;
		closeEdit();
		await invalidateAll();
	}

	async function deleteFromEdit() {
		if (!editItem) return;
		await fetch('/collection', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: editItem.id })
		});
		closeEdit();
		await invalidateAll();
	}

	function doSearch() {
		const params = new URLSearchParams($page.url.searchParams);
		if (search) params.set('q', search);
		else params.delete('q');
		params.delete('page');
		goto(`/collection?${params.toString()}`);
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
		goto(`/collection?${params.toString()}`);
	}

	function filterByTag(tagId: string | null) {
		const params = new URLSearchParams($page.url.searchParams);
		if (tagId) params.set('tag', tagId);
		else params.delete('tag');
		params.delete('page');
		goto(`/collection?${params.toString()}`);
	}

	function goToPage(p: number) {
		const params = new URLSearchParams($page.url.searchParams);
		params.set('page', p.toString());
		goto(`/collection?${params.toString()}`);
	}

	async function createTag() {
		if (!newTagName.trim()) return;
		await fetch('/tags', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: newTagName.trim(), color: newTagColor })
		});
		newTagName = '';
		showTagForm = false;
		await invalidateAll();
	}

	async function deleteTag(tagId: number) {
		await fetch('/tags', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: tagId })
		});
		await invalidateAll();
	}

	async function toggleTag(collectionCardId: number, tagId: number, hasTag: boolean) {
		await fetch('/tags', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: hasTag ? 'remove' : 'add',
				collectionCardId,
				tagId
			})
		});
		await invalidateAll();
	}

	async function fillPurchasePrices() {
		fillingPrices = true;
		await fetch('/collection', { method: 'PATCH' });
		fillingPrices = false;
		await invalidateAll();
	}

	async function removeFromCollection(id: number) {
		await fetch('/collection', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id })
		});
		await invalidateAll();
	}

	function priceChange(item: Record<string, unknown>): { percent: number; direction: string; color: string } | null {
		const purchasePrice = item.purchase_price as number | null;
		let currentPrice = (item.foil ? item.price_eur_foil : item.price_eur) as number | null;
		// Fallback: convert USD to EUR if no EUR price available
		if (currentPrice == null) {
			const usdPrice = (item.foil ? item.price_usd_foil : item.price_usd) as number | null;
			if (usdPrice != null) currentPrice = usdPrice * data.usdToEur;
		}
		if (purchasePrice == null || !purchasePrice || currentPrice == null) return null;
		const percent = ((currentPrice - purchasePrice) / purchasePrice) * 100;
		if (percent > 0) return { percent, direction: '▲', color: 'text-green-400' };
		if (percent < 0) return { percent, direction: '▼', color: 'text-red-400' };
		return { percent: 0, direction: '—', color: 'text-[var(--color-text-muted)]' };
	}

	function getImageSrc(item: Record<string, unknown>): string {
		if (item.local_image_path) return item.local_image_path as string;
		if (item.image_uri) return item.image_uri as string;
		return '';
	}

	function formatDate(dateStr: unknown): string {
		if (!dateStr) return '';
		try {
			return new Date(dateStr as string).toLocaleString();
		} catch {
			return dateStr as string;
		}
	}
</script>

<!-- Edit Modal -->
{#if editItem}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
		onkeydown={(e: KeyboardEvent) => { if (e.key === 'Escape') closeEdit(); }}
		onclick={(e: MouseEvent) => { if (e.target === e.currentTarget) closeEdit(); }}
	>
		<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
			<!-- Header -->
			<div class="flex items-center justify-between p-5 border-b border-[var(--color-border)]">
				<h2 class="text-lg font-bold">Edit Collection Card</h2>
				<button onclick={closeEdit} class="text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-2xl leading-none">&times;</button>
			</div>

			<!-- Body -->
			<div class="p-5 flex gap-6">
				<!-- Card Image -->
				<div class="flex-shrink-0 w-48">
					{#if getImageSrc(editItem)}
						<CardPreview src={getImageSrc(editItem)} alt={editItem.name as string} scale={1.7}>
							<img src={getImageSrc(editItem)} alt={editItem.name as string} class="w-full rounded-lg shadow-lg" />
						</CardPreview>
					{:else}
						<div class="w-full aspect-[488/680] bg-[var(--color-bg)] rounded-lg flex items-center justify-center text-[var(--color-text-muted)] text-sm p-2 text-center">
							{editItem.name}
						</div>
					{/if}
					<a href="/cards/{editItem.card_id}" class="block text-center text-sm text-[var(--color-primary)] hover:underline mt-3">
						Go to card page
					</a>
				</div>

				<!-- Form -->
				<div class="flex-1 space-y-4">
					<!-- Card Name & Set -->
					<div>
						<p class="font-semibold text-lg">{editItem.name}</p>
						<p class="text-sm text-[var(--color-text-muted)]">
							{editItem.set_name}
							({(editItem.set_code as string).toUpperCase()}) #{editItem.collector_number}
						</p>
					</div>

					<!-- Quantity & Condition Row -->
					<div class="grid grid-cols-3 gap-3">
						<div>
							<label for="edit-qty" class="block text-xs text-[var(--color-text-muted)] mb-1">Quantity</label>
							<div class="flex items-center">
								<button
									onclick={() => { if (editQuantity > 1) editQuantity--; }}
									class="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-l px-2 py-1.5 hover:bg-[var(--color-surface-hover)]"
								>&minus;</button>
								<input
									id="edit-qty"
									type="number"
									bind:value={editQuantity}
									min="1"
									class="w-14 text-center bg-[var(--color-bg)] border-y border-[var(--color-border)] py-1.5 focus:outline-none"
								/>
								<button
									onclick={() => editQuantity++}
									class="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-r px-2 py-1.5 hover:bg-[var(--color-surface-hover)]"
								>+</button>
							</div>
						</div>
						<div>
							<label for="edit-condition" class="block text-xs text-[var(--color-text-muted)] mb-1">Condition</label>
							<select id="edit-condition" bind:value={editCondition} class="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1.5">
								<option value="near_mint">Near Mint</option>
								<option value="lightly_played">Lightly Played</option>
								<option value="moderately_played">Moderately Played</option>
								<option value="heavily_played">Heavily Played</option>
								<option value="damaged">Damaged</option>
							</select>
						</div>
						<div>
							<label for="edit-finish" class="block text-xs text-[var(--color-text-muted)] mb-1">Finish</label>
							<select id="edit-finish" bind:value={editFoil} class="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1.5">
								<option value={false}>Non-Foil</option>
								<option value={true}>Foil</option>
							</select>
						</div>
					</div>

					<!-- Purchase Price -->
					<div>
						<label for="edit-purchase-price" class="block text-xs text-[var(--color-text-muted)] mb-1">Purchase Price (EUR)</label>
						<input
							id="edit-purchase-price"
							type="number"
							bind:value={editPurchasePrice}
							step="0.01"
							min="0"
							placeholder="e.g. 3.50"
							class="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1.5 focus:outline-none focus:border-[var(--color-primary)]"
						/>
					</div>

					<!-- Price Info -->
					<div class="grid grid-cols-2 gap-3">
						<div class="bg-[var(--color-bg)] rounded p-3 border border-[var(--color-border)]">
							<span class="text-xs text-[var(--color-text-muted)]">Current Price</span>
							<p class="font-medium text-[var(--color-accent)]">
								{formatPrice((editItem.foil ? editItem.price_eur_foil : editItem.price_eur) as number | null, (editItem.foil ? editItem.price_usd_foil : editItem.price_usd) as number | null)}
							</p>
						</div>
						<div class="bg-[var(--color-bg)] rounded p-3 border border-[var(--color-border)]">
							<span class="text-xs text-[var(--color-text-muted)]">Since Purchase</span>
							{#if priceChange(editItem)}
								<p class="font-medium {priceChange(editItem)!.color}">
									{priceChange(editItem)!.direction} {Math.abs(priceChange(editItem)!.percent).toFixed(1)}%
								</p>
							{:else}
								<p class="font-medium text-[var(--color-text-muted)]">—</p>
							{/if}
						</div>
					</div>

					<!-- Tags -->
					{#if data.tags.length > 0}
						<div>
							<span class="block text-xs text-[var(--color-text-muted)] mb-1.5">Tags</span>
							<div class="flex flex-wrap gap-1.5">
								{#each data.tags as tag}
									{@const hasTag = (editItem.tags as Array<Record<string, unknown>>).some((t) => t.id === tag.id)}
									<button
										onclick={() => toggleTag(editItem!.id as number, tag.id as number, hasTag)}
										class="px-2.5 py-1 rounded-full text-xs transition-colors"
										style="background: {hasTag ? tag.color : 'transparent'}; border: 1px solid {tag.color}; color: {hasTag ? 'white' : tag.color}"
									>
										{tag.name}
									</button>
								{/each}
							</div>
						</div>
					{/if}

					<!-- Notes -->
					<div>
						<label for="edit-notes" class="block text-xs text-[var(--color-text-muted)] mb-1">Notes</label>
						<textarea
							id="edit-notes"
							bind:value={editNotes}
							rows="3"
							placeholder="Add notes about this card..."
							class="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm resize-none focus:outline-none focus:border-[var(--color-primary)]"
						></textarea>
					</div>

					<!-- Dates -->
					<div class="text-xs text-[var(--color-text-muted)]">
						{#if editItem.added_at}
							<p>Added {formatDate(editItem.added_at)}</p>
						{/if}
					</div>
				</div>
			</div>

			<!-- Footer -->
			<div class="flex items-center justify-between p-5 border-t border-[var(--color-border)]">
				<button
					onclick={deleteFromEdit}
					class="text-red-400 hover:text-red-300 text-sm transition-colors"
				>
					Remove from collection
				</button>
				<div class="flex gap-2">
					<button
						onclick={closeEdit}
						class="bg-[var(--color-bg)] hover:bg-[var(--color-surface-hover)] px-4 py-2 rounded-lg text-sm border border-[var(--color-border)] transition-colors"
					>
						Cancel
					</button>
					<button
						onclick={saveEdit}
						disabled={saving}
						class="bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] px-6 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
					>
						{saving ? 'Saving...' : 'Save'}
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold">My Collection</h1>
		<div class="flex gap-2">
			<button
				onclick={fillPurchasePrices}
				disabled={fillingPrices}
				class="bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] px-4 py-2 rounded-lg text-sm border border-[var(--color-border)] transition-colors disabled:opacity-50"
			>
				{fillingPrices ? 'Setting...' : 'Set missing purchase prices'}
			</button>
			<a
				href="/collection/scan"
				class="bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] px-4 py-2 rounded-lg text-sm border border-[var(--color-border)] transition-colors"
			>
				Scan Card
			</a>
			<a
				href="/collection/import"
				class="bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] px-4 py-2 rounded-lg text-sm border border-[var(--color-border)] transition-colors"
			>
				Import from Moxfield
			</a>
			<a
				href="/collection/export"
				download="moxfield_collection.csv"
				class="bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] px-4 py-2 rounded-lg text-sm border border-[var(--color-border)] transition-colors"
			>
				Export for Moxfield
			</a>
		</div>
	</div>

	<!-- Stats -->
	<div class="grid grid-cols-3 gap-4">
		<div class="bg-[var(--color-surface)] rounded-lg p-4 border border-[var(--color-border)]">
			<p class="text-sm text-[var(--color-text-muted)]">Unique Cards</p>
			<p class="text-2xl font-bold">{data.stats.uniqueCards}</p>
		</div>
		<div class="bg-[var(--color-surface)] rounded-lg p-4 border border-[var(--color-border)]">
			<p class="text-sm text-[var(--color-text-muted)]">Total Cards</p>
			<p class="text-2xl font-bold">{data.stats.totalCards}</p>
		</div>
		<div class="bg-[var(--color-surface)] rounded-lg p-4 border border-[var(--color-border)]">
			<p class="text-sm text-[var(--color-text-muted)]">Total Value</p>
			<p class="text-2xl font-bold text-[var(--color-accent)]">{formatPrice(data.stats.totalValue)}</p>
		</div>
	</div>

	<!-- Tags -->
	<div class="flex items-center gap-2 flex-wrap">
		<span class="text-sm text-[var(--color-text-muted)]">Tags:</span>
		<button
			onclick={() => filterByTag(null)}
			class="px-3 py-1 rounded-full text-xs transition-colors {!data.filters.tagFilter ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-surface)] text-[var(--color-text-muted)] border border-[var(--color-border)]'}"
		>
			All
		</button>
		{#each data.tags as tag}
			<span class="px-3 py-1 rounded-full text-xs transition-colors flex items-center gap-1 cursor-pointer"
				style="background: {data.filters.tagFilter === String(tag.id) ? tag.color : 'transparent'}; border: 1px solid {tag.color}; color: {data.filters.tagFilter === String(tag.id) ? 'white' : tag.color}"
			>
				<span onclick={() => filterByTag(String(tag.id))} role="button" tabindex="0" onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') filterByTag(String(tag.id)); }}>{tag.name}</span>
				<button onclick={() => deleteTag(tag.id as number)} class="ml-1 hover:text-red-400">&times;</button>
			</span>
		{/each}
		<button
			onclick={() => showTagForm = !showTagForm}
			class="px-3 py-1 rounded-full text-xs bg-[var(--color-surface)] border border-dashed border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
		>
			+ New Tag
		</button>
	</div>

	{#if showTagForm}
		<div class="flex items-center gap-2 bg-[var(--color-surface)] rounded-lg p-3 border border-[var(--color-border)]">
			<input
				type="text"
				bind:value={newTagName}
				placeholder="Tag name"
				class="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-sm"
			/>
			<input type="color" bind:value={newTagColor} class="w-8 h-8 rounded cursor-pointer" />
			<button onclick={createTag} class="bg-[var(--color-primary)] px-3 py-1 rounded text-sm">Create</button>
		</div>
	{/if}

	<!-- Search & Sort -->
	<div class="flex gap-2">
		<form onsubmit={(e) => { e.preventDefault(); doSearch(); }} class="flex-1 flex gap-2">
			<input
				type="text"
				bind:value={search}
				placeholder="Search collection..."
				class="flex-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg px-4 py-2 text-sm placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-primary)]"
			/>
			<button type="submit" class="bg-[var(--color-primary)] px-4 py-2 rounded-lg text-sm">Search</button>
		</form>
		<div class="flex gap-1">
			{#each [['name', 'Name'], ['added_at', 'Date'], ['price', 'Price'], ['profit', 'Profit %'], ['profit_total', 'Profit €'], ['set_name', 'Set']] as [key, label]}
				<button
					onclick={() => setSort(key)}
					class="px-3 py-2 rounded-lg text-xs transition-colors {data.filters.sortBy === key ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-surface)] border border-[var(--color-border)]'}"
				>
					{label} {data.filters.sortBy === key ? (data.filters.sortDir === 'asc' ? '▲' : '▼') : ''}
				</button>
			{/each}
		</div>
	</div>

	<!-- Collection Items -->
	{#if data.items.length === 0}
		<div class="text-center py-12 text-[var(--color-text-muted)]">
			<p class="text-lg">Your collection is empty.</p>
			<p class="text-sm mt-2">
				<a href="/cards" class="text-[var(--color-primary)] hover:underline">Browse cards</a> to start adding.
			</p>
		</div>
	{:else}
		<div class="space-y-2">
			{#each data.items as item}
				{@const imgSrc = getImageSrc(item)}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-3 flex items-center gap-4 cursor-pointer hover:border-[var(--color-primary)] transition-colors"
					onclick={() => openEdit(item)}
				>
					<!-- Thumbnail -->
					<div class="flex-shrink-0">
						{#if imgSrc}
							<CardPreview src={imgSrc} alt={item.name as string} scale={2.4}>
								<img src={imgSrc} alt={item.name as string} class="w-16 h-22 object-cover rounded" loading="lazy" />
							</CardPreview>
						{:else}
							<div class="w-16 h-22 bg-[var(--color-bg)] rounded"></div>
						{/if}
					</div>

					<!-- Info -->
					<div class="flex-1 min-w-0">
						<p class="font-medium">{item.name}</p>
						<div class="flex items-center gap-3 mt-1 text-sm text-[var(--color-text-muted)]">
							<span>{item.quantity}x</span>
							<span>{conditionLabel(item.condition as string)}</span>
							{#if item.foil}
								<span class="text-[var(--color-accent)]">FOIL</span>
							{/if}
							<span>{item.set_name}</span>
						</div>
						<!-- Tags -->
						<div class="flex gap-1 mt-1 flex-wrap">
							{#each (item.tags as Array<Record<string, unknown>>) as tag}
								<span
									class="px-2 py-0.5 rounded-full text-xs"
									style="background: {tag.color}22; color: {tag.color}; border: 1px solid {tag.color}44"
								>
									{tag.name}
								</span>
							{/each}
						</div>
					</div>

					<!-- Price -->
					<div class="text-right flex-shrink-0">
						<p class="text-[var(--color-accent)] font-medium">
							{formatPrice((item.foil ? item.price_eur_foil : item.price_eur) as number | null, (item.foil ? item.price_usd_foil : item.price_usd) as number | null)}
						</p>
						{#if priceChange(item)}
							<p class="text-xs {priceChange(item)!.color}">
								{priceChange(item)!.direction} {Math.abs(priceChange(item)!.percent).toFixed(1)}%
							</p>
						{:else if (item.quantity as number) > 1}
							<p class="text-xs text-[var(--color-text-muted)]">
								{formatPrice(((item.foil ? item.price_eur_foil : item.price_eur) as number ?? 0) * (item.quantity as number), ((item.foil ? item.price_usd_foil : item.price_usd) as number ?? 0) * (item.quantity as number))} total
							</p>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}

	<!-- Pagination -->
	{#if data.totalPages > 1}
		<div class="flex items-center justify-center gap-2">
			<button
				onclick={() => goToPage(data.page - 1)}
				disabled={data.page <= 1}
				class="px-3 py-1.5 rounded bg-[var(--color-surface)] border border-[var(--color-border)] disabled:opacity-30"
			>
				Prev
			</button>
			<span class="text-[var(--color-text-muted)] px-4">Page {data.page} of {data.totalPages}</span>
			<button
				onclick={() => goToPage(data.page + 1)}
				disabled={data.page >= data.totalPages}
				class="px-3 py-1.5 rounded bg-[var(--color-surface)] border border-[var(--color-border)] disabled:opacity-30"
			>
				Next
			</button>
		</div>
	{/if}
</div>
