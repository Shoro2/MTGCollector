<script lang="ts">
	import type { PageData } from './$types';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/stores';
	import { formatPrice, conditionLabel } from '$lib/utils';

	let { data }: { data: PageData } = $props();

	let search = $state(data.filters.search);
	let newTagName = $state('');
	let newTagColor = $state('#3b82f6');
	let showTagForm = $state(false);

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

	async function removeFromCollection(id: number) {
		await fetch('/collection', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id })
		});
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
		<h1 class="text-2xl font-bold">My Collection</h1>
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
			{#each [['name', 'Name'], ['added_at', 'Date'], ['price', 'Price'], ['set_name', 'Set']] as [key, label]}
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
				<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-3 flex items-center gap-4">
					<!-- Thumbnail -->
					<a href="/cards/{item.card_id}" class="flex-shrink-0">
						{#if imgSrc}
							<img src={imgSrc} alt={item.name as string} class="w-16 h-22 object-cover rounded" loading="lazy" />
						{:else}
							<div class="w-16 h-22 bg-[var(--color-bg)] rounded"></div>
						{/if}
					</a>

					<!-- Info -->
					<div class="flex-1 min-w-0">
						<a href="/cards/{item.card_id}" class="font-medium hover:text-[var(--color-primary)] transition-colors">
							{item.name}
						</a>
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
							<!-- Tag toggle dropdown -->
							{#if data.tags.length > 0}
								<div class="relative group">
									<button class="px-2 py-0.5 rounded-full text-xs bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-muted)]">+</button>
									<div class="absolute left-0 top-full mt-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded shadow-lg p-1 hidden group-hover:block z-10 min-w-[120px]">
										{#each data.tags as tag}
											{@const hasTag = (item.tags as Array<Record<string, unknown>>).some((t) => t.id === tag.id)}
											<button
												onclick={() => toggleTag(item.id as number, tag.id as number, hasTag)}
												class="block w-full text-left px-2 py-1 text-xs rounded hover:bg-[var(--color-surface-hover)] {hasTag ? 'font-bold' : ''}"
												style="color: {tag.color}"
											>
												{hasTag ? '✓ ' : ''}{tag.name}
											</button>
										{/each}
									</div>
								</div>
							{/if}
						</div>
					</div>

					<!-- Price & Actions -->
					<div class="text-right flex-shrink-0">
						<p class="text-[var(--color-accent)] font-medium">
							{formatPrice((item.foil ? item.price_eur_foil : item.price_eur) as number | null)}
						</p>
						<button
							onclick={() => removeFromCollection(item.id as number)}
							class="text-red-400 hover:text-red-300 text-xs mt-1"
						>
							Remove
						</button>
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
