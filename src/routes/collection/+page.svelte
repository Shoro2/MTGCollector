<script lang="ts">
	import type { PageData } from './$types';
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { formatPrice, conditionLabel, priceDate, scryfallSrcset } from '$lib/utils';
	import CardPreview from '$lib/components/CardPreview.svelte';
	import type { Chart } from 'chart.js';
	import { loadChart } from '$lib/chart-loader';

	let { data }: { data: PageData } = $props();

	// Price history modal
	let modalOpen = $state(false);
	let modalCard = $state<{ name: string; set_name: string } | null>(null);
	let modalChartCanvas = $state<HTMLCanvasElement>(null!);
	let modalChart: Chart | null = null;
	let modalLoading = $state(false);

	async function openCardChart(cardId: string) {
		modalLoading = true;
		modalOpen = true;
		modalCard = null;
		const [res, ChartCtor] = await Promise.all([
			fetch(`/api/prices/card?id=${encodeURIComponent(cardId)}`),
			loadChart()
		]);
		const result = await res.json();
		modalLoading = false;
		if (!result.card) return;
		modalCard = result.card;
		setTimeout(() => {
			if (!modalChartCanvas || !result.history.length) return;
			modalChart?.destroy();
			modalChart = new ChartCtor(modalChartCanvas, {
				type: 'line',
				data: {
					labels: result.history.map((h: Record<string, unknown>) => priceDate(h.recorded_at as string)),
					datasets: [
						{
							label: 'Price (EUR)',
							data: result.history.map((h: Record<string, unknown>) => h.price_eur as number),
							borderColor: '#3b82f6',
							tension: 0.3
						},
						{
							label: 'Foil Price (EUR)',
							data: result.history.map((h: Record<string, unknown>) => h.price_eur_foil as number),
							borderColor: '#f59e0b',
							tension: 0.3
						}
					]
				},
				options: {
					responsive: true,
					plugins: { legend: { labels: { color: '#94a3b8' } } },
					scales: {
						x: { ticks: { color: '#94a3b8' }, grid: { color: '#334155' } },
						y: { ticks: { color: '#94a3b8', callback: (v) => `€${v}` }, grid: { color: '#334155' } }
					}
				}
			});
		}, 0);
	}

	function closeModal() {
		modalOpen = false;
		modalChart?.destroy();
		modalChart = null;
	}

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

	// Auto-open edit modal from URL param (e.g. from prices page). Chart.js
	// registration is deferred until the user opens a chart modal.
	onMount(() => {
		if (data.editCard) {
			openEdit(data.editCard);
		}
		return () => modalChart?.destroy();
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
		await invalidate('app:collection');
	}

	async function deleteFromEdit() {
		if (!editItem) return;
		await fetch('/collection', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: editItem.id })
		});
		closeEdit();
		await invalidate('app:collection');
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
		await invalidate('app:collection');
	}

	async function deleteTag(tagId: number) {
		await fetch('/tags', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: tagId })
		});
		await invalidate('app:collection');
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
		await invalidate('app:collection');
	}

	async function fillPurchasePrices() {
		fillingPrices = true;
		await fetch('/collection', { method: 'PATCH' });
		fillingPrices = false;
		await invalidate('app:collection');
	}

	async function removeFromCollection(id: number) {
		await fetch('/collection', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id })
		});
		await invalidate('app:collection');
	}

	// Import/Export modals
	type ImportResult = {
		success: boolean;
		imported?: number;
		notFound?: number;
		notFoundCards?: string[];
		parseErrors?: string[];
		parseErrorCount?: number;
		total?: number;
		mode?: string;
		format?: string;
		message?: string;
	};

	let showImportModal = $state(false);
	let showExportModal = $state(false);
	let importFormat = $state<'csv' | 'text'>('csv');
	let exportFormat = $state<'csv' | 'text'>('csv');
	let importMode = $state<'append' | 'sync'>('append');
	let importText = $state('');
	let importFile = $state<File | null>(null);
	let importFileInput = $state<HTMLInputElement>(null!);
	let importConfirmSync = $state(false);
	let importing = $state(false);
	let importResult = $state<ImportResult | null>(null);
	let exportText = $state('');
	let exportLoading = $state(false);
	let exportCopied = $state(false);

	function openImportModal() {
		showImportModal = true;
		importFormat = 'csv';
		importMode = 'append';
		importText = '';
		importFile = null;
		importConfirmSync = false;
		importResult = null;
	}

	function closeImportModal() {
		if (importing) return;
		showImportModal = false;
	}

	function onImportFileChange(e: Event) {
		const input = e.target as HTMLInputElement;
		importFile = input.files?.[0] ?? null;
		importResult = null;
	}

	function setImportFormat(f: 'csv' | 'text') {
		importFormat = f;
		importResult = null;
		importConfirmSync = false;
	}

	async function doImport() {
		if (importFormat === 'csv' && !importFile) return;
		if (importFormat === 'text' && !importText.trim()) return;

		if (importMode === 'sync' && !importConfirmSync) {
			importConfirmSync = true;
			return;
		}

		importing = true;
		importConfirmSync = false;

		const formData = new FormData();
		formData.append('format', importFormat);
		formData.append('mode', importMode);
		if (importFormat === 'csv' && importFile) {
			formData.append('file', importFile);
		} else if (importFormat === 'text') {
			formData.append('text', importText);
		}

		try {
			const response = await fetch('/collection/import', {
				method: 'POST',
				body: formData
			});
			importResult = await response.json();
		} catch (err) {
			importResult = { success: false, message: (err as Error).message || 'Import failed' };
		}

		importing = false;

		if (importResult?.success) {
			await invalidate('app:collection');
		}
	}

	async function openExportModal() {
		showExportModal = true;
		exportFormat = 'csv';
		exportText = '';
		exportCopied = false;
	}

	function closeExportModal() {
		showExportModal = false;
	}

	async function setExportFormat(f: 'csv' | 'text') {
		exportFormat = f;
		exportCopied = false;
		if (f === 'text' && !exportText && !exportLoading) {
			exportLoading = true;
			try {
				const res = await fetch('/collection/export?format=text');
				exportText = await res.text();
			} catch (err) {
				exportText = `Error: ${(err as Error).message}`;
			}
			exportLoading = false;
		}
	}

	async function copyExportText() {
		try {
			await navigator.clipboard.writeText(exportText);
			exportCopied = true;
			setTimeout(() => { exportCopied = false; }, 2000);
		} catch {
			// Clipboard API may be unavailable — fall back to selection
		}
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

<svelte:head>
	<title>My Collection | MTG Collector</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

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
			<div class="p-5 flex flex-col sm:flex-row gap-6">
				<!-- Card Image -->
				<div class="flex-shrink-0 w-40 sm:w-48 mx-auto sm:mx-0">
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
					<div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
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
					<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
								{#each data.tags as tag (tag.id)}
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
			<div class="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 p-5 border-t border-[var(--color-border)]">
				<button
					onclick={deleteFromEdit}
					class="text-red-400 hover:text-red-300 text-sm transition-colors text-left"
				>
					Remove from collection
				</button>
				<div class="flex gap-2 justify-end">
					<button
						onclick={closeEdit}
						class="bg-[var(--color-bg)] hover:bg-[var(--color-surface-hover)] px-4 py-2 rounded-lg text-sm border border-[var(--color-border)] transition-colors"
					>
						Cancel
					</button>
					<button
						onclick={saveEdit}
						disabled={saving}
						class="bg-[var(--color-primary-button)] hover:bg-[var(--color-primary-button-hover)] px-6 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
					>
						{saving ? 'Saving...' : 'Save'}
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}

<div class="space-y-6">
	<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
		<h1 class="text-2xl font-bold">My Collection</h1>
		<div class="flex flex-wrap gap-2">
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
			<button
				onclick={openImportModal}
				class="bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] px-4 py-2 rounded-lg text-sm border border-[var(--color-border)] transition-colors"
			>
				Import
			</button>
			<button
				onclick={openExportModal}
				class="bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] px-4 py-2 rounded-lg text-sm border border-[var(--color-border)] transition-colors"
			>
				Export
			</button>
		</div>
	</div>

	<!-- Stats -->
	<div class="grid grid-cols-3 gap-2 sm:gap-4">
		<div class="bg-[var(--color-surface)] rounded-lg p-3 sm:p-4 border border-[var(--color-border)] min-w-0">
			<p class="text-xs sm:text-sm text-[var(--color-text-muted)]">Unique Cards</p>
			<p class="text-xl sm:text-2xl font-bold break-words">{data.stats.uniqueCards}</p>
		</div>
		<div class="bg-[var(--color-surface)] rounded-lg p-3 sm:p-4 border border-[var(--color-border)] min-w-0">
			<p class="text-xs sm:text-sm text-[var(--color-text-muted)]">Total Cards</p>
			<p class="text-xl sm:text-2xl font-bold break-words">{data.stats.totalCards}</p>
		</div>
		<div class="bg-[var(--color-surface)] rounded-lg p-3 sm:p-4 border border-[var(--color-border)] min-w-0">
			<p class="text-xs sm:text-sm text-[var(--color-text-muted)]">Total Value</p>
			<p class="text-xl sm:text-2xl font-bold text-[var(--color-accent)] break-words">{formatPrice(data.stats.totalValue)}</p>
		</div>
	</div>

	<!-- Tags -->
	<div class="flex items-center gap-2 flex-wrap">
		<span class="text-sm text-[var(--color-text-muted)]">Tags:</span>
		<button
			onclick={() => filterByTag(null)}
			class="px-3 py-1 rounded-full text-xs transition-colors {!data.filters.tagFilter ? 'bg-[var(--color-primary-button)] text-white' : 'bg-[var(--color-surface)] text-[var(--color-text-muted)] border border-[var(--color-border)]'}"
		>
			All
		</button>
		{#each data.tags as tag (tag.id)}
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
			<button onclick={createTag} class="bg-[var(--color-primary-button)] px-3 py-1 rounded text-sm">Create</button>
		</div>
	{/if}

	<!-- Search & Sort -->
	<div class="flex flex-col sm:flex-row gap-2">
		<form onsubmit={(e) => { e.preventDefault(); doSearch(); }} class="flex-1 flex gap-2">
			<input
				type="text"
				bind:value={search}
				placeholder="Search collection..."
				class="flex-1 min-w-0 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg px-4 py-2 text-sm placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-primary)]"
			/>
			<button type="submit" class="bg-[var(--color-primary-button)] px-4 py-2 rounded-lg text-sm">Search</button>
		</form>
		<div class="flex flex-wrap gap-1">
			{#each [['name', 'Name'], ['added_at', 'Date'], ['price', 'Price'], ['profit', 'Profit %'], ['profit_total', 'Profit €'], ['quantity', 'Amount'], ['set_name', 'Set']] as [key, label]}
				<button
					onclick={() => setSort(key)}
					class="px-3 py-2 rounded-lg text-xs transition-colors {data.filters.sortBy === key ? 'bg-[var(--color-primary-button)]' : 'bg-[var(--color-surface)] border border-[var(--color-border)]'}"
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
			{#each data.items as item (item.id)}
				{@const imgSrc = getImageSrc(item)}
				{@const srcset = item.local_image_path ? null : scryfallSrcset(item.image_uri as string | null)}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-3 flex items-start sm:items-center gap-3 sm:gap-4 cursor-pointer hover:border-[var(--color-primary)] transition-colors"
					onclick={() => openEdit(item)}
				>
					<!-- Thumbnail -->
					<div class="flex-shrink-0">
						{#if imgSrc}
							<CardPreview src={imgSrc} alt={item.name as string} scale={2.4}>
								<img src={imgSrc} srcset={srcset ?? undefined} sizes="80px" alt={item.name as string} class="w-14 h-20 sm:w-16 sm:h-22 object-cover rounded" loading="lazy" />
							</CardPreview>
						{:else}
							<div class="w-14 h-20 sm:w-16 sm:h-22 bg-[var(--color-bg)] rounded"></div>
						{/if}
					</div>

					<div class="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-center sm:gap-4">
						<!-- Info -->
						<div class="flex-1 min-w-0">
							<p class="font-medium break-words">{item.name}</p>
							<div class="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-sm text-[var(--color-text-muted)]">
								<span>{item.quantity}x</span>
								<span>{conditionLabel(item.condition as string)}</span>
								{#if item.foil}
									<span class="text-[var(--color-accent)]">FOIL</span>
								{/if}
								<span class="break-words">{item.set_name}</span>
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

						<!-- Price + chart button row (stacks on desktop side, inline below info on mobile) -->
						<div class="flex items-center justify-between sm:justify-end gap-2 mt-2 sm:mt-0 sm:flex-shrink-0">
							<!-- Price -->
							<div class="text-left sm:text-right">
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
							<button
								onclick={(e) => { e.stopPropagation(); openCardChart(item.card_id as string); }}
								class="p-2 rounded-lg hover:bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors flex-shrink-0"
								title="Price history"
							>
								<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
									<path stroke-linecap="round" stroke-linejoin="round" d="M3 13l4-4 4 4 4-8 6 6" />
									<path stroke-linecap="round" stroke-linejoin="round" d="M3 20h18" />
								</svg>
							</button>
						</div>
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

<!-- Import Modal -->
{#if showImportModal}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
		onclick={(e) => { if (e.target === e.currentTarget) closeImportModal(); }}
		onkeydown={(e) => { if (e.key === 'Escape') closeImportModal(); }}
	>
		<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] w-full max-w-2xl max-h-[90vh] overflow-y-auto">
			<div class="flex items-center justify-between p-5 border-b border-[var(--color-border)]">
				<h2 class="text-lg font-bold">Import to Collection</h2>
				<button onclick={closeImportModal} class="text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-2xl leading-none">&times;</button>
			</div>

			<div class="p-5 space-y-5">
				<!-- Format tabs -->
				<div class="flex gap-1 border-b border-[var(--color-border)]">
					<button
						type="button"
						onclick={() => setImportFormat('csv')}
						class="px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px {importFormat === 'csv' ? 'border-[var(--color-primary)] text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}"
					>
						Moxfield CSV
					</button>
					<button
						type="button"
						onclick={() => setImportFormat('text')}
						class="px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px {importFormat === 'text' ? 'border-[var(--color-primary)] text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}"
					>
						Text paste
					</button>
				</div>

				<!-- Mode selection -->
				<div class="space-y-2">
					<p class="text-sm font-medium">Import Mode</p>
					<div class="flex flex-col sm:flex-row gap-3">
						<label class="flex items-start gap-3 bg-[var(--color-bg)] rounded-lg p-3 border cursor-pointer flex-1 transition-colors {importMode === 'append' ? 'border-[var(--color-primary)]' : 'border-[var(--color-border)]'}">
							<input type="radio" bind:group={importMode} value="append" class="mt-1" />
							<div>
								<p class="font-medium text-sm">Append</p>
								<p class="text-xs text-[var(--color-text-muted)]">Add cards to your existing collection.</p>
							</div>
						</label>
						<label class="flex items-start gap-3 bg-[var(--color-bg)] rounded-lg p-3 border cursor-pointer flex-1 transition-colors {importMode === 'sync' ? 'border-[var(--color-primary)]' : 'border-[var(--color-border)]'}">
							<input type="radio" bind:group={importMode} value="sync" class="mt-1" />
							<div>
								<p class="font-medium text-sm">Sync</p>
								<p class="text-xs text-[var(--color-text-muted)]">Replace the entire collection. All existing cards and tags are removed.</p>
							</div>
						</label>
					</div>
				</div>

				<!-- CSV tab body -->
				{#if importFormat === 'csv'}
					<div class="bg-[var(--color-bg)] rounded-lg p-3 border border-[var(--color-border)] text-xs text-[var(--color-text-muted)] space-y-1">
						<p class="font-medium text-[var(--color-text)]">How to export from Moxfield:</p>
						<ol class="list-decimal list-inside space-y-0.5">
							<li>Open your Moxfield collection</li>
							<li>Click the export/download button</li>
							<li>Choose CSV format</li>
							<li>Upload the file here</li>
						</ol>
					</div>
					<div>
						<label for="csv-file" class="block text-sm font-medium mb-2">CSV File</label>
						<input
							id="csv-file"
							type="file"
							accept=".csv"
							onchange={onImportFileChange}
							bind:this={importFileInput}
							class="block w-full text-sm text-[var(--color-text-muted)]
								file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0
								file:text-sm file:font-medium file:bg-[var(--color-primary-button)]
								file:text-white file:cursor-pointer hover:file:bg-[var(--color-primary-hover)]"
						/>
						{#if importFile}
							<p class="text-xs text-[var(--color-text-muted)] mt-1">{importFile.name} ({(importFile.size / 1024).toFixed(1)} KB)</p>
						{/if}
					</div>
				{:else}
					<div class="bg-[var(--color-bg)] rounded-lg p-3 border border-[var(--color-border)] text-xs text-[var(--color-text-muted)] space-y-1">
						<p class="font-medium text-[var(--color-text)]">Format: <code>count Name (SET) number</code> — append <code>*F*</code> for foil.</p>
						<p>Example: <code>1 An Offer You Can't Refuse (SNC) 51</code></p>
						<p>Condition defaults to Near Mint; purchase price is left empty.</p>
					</div>
					<div>
						<label for="import-text" class="block text-sm font-medium mb-2">Card list</label>
						<textarea
							id="import-text"
							bind:value={importText}
							rows="10"
							placeholder={`1 An Offer You Can't Refuse (SNC) 51\n1 Arcane Signet (WOC) 145\n1 Clearwater Pathway / Murkwater Pathway (ZNR) 286 *F*`}
							class="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[var(--color-primary)]"
						></textarea>
					</div>
				{/if}

				<!-- Sync warning -->
				{#if importConfirmSync}
					<div class="bg-red-900/30 border border-red-500/50 rounded-lg p-4">
						<p class="text-red-300 font-medium">Warning: This will delete your entire collection!</p>
						<p class="text-red-300/70 text-sm mt-1">All existing cards and tag assignments will be removed and replaced with the import.</p>
						<div class="flex gap-2 mt-3">
							<button
								onclick={doImport}
								disabled={importing}
								class="bg-red-600 hover:bg-red-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
							>
								{importing ? 'Importing...' : 'Confirm Sync'}
							</button>
							<button
								onclick={() => importConfirmSync = false}
								class="bg-[var(--color-bg)] hover:bg-[var(--color-surface-hover)] px-4 py-2 rounded-lg text-sm border border-[var(--color-border)] transition-colors"
							>
								Cancel
							</button>
						</div>
					</div>
				{:else}
					<button
						onclick={doImport}
						disabled={importing || (importFormat === 'csv' ? !importFile : !importText.trim())}
						class="bg-[var(--color-primary-button)] hover:bg-[var(--color-primary-button-hover)] px-6 py-2.5 rounded-lg font-medium transition-colors disabled:opacity-50"
					>
						{importing ? 'Importing...' : `Import (${importMode === 'sync' ? 'Sync' : 'Append'})`}
					</button>
				{/if}

				<!-- Result -->
				{#if importResult}
					<div class="rounded-lg p-4 border {importResult.success ? 'bg-green-900/20 border-green-500/50' : 'bg-red-900/20 border-red-500/50'}">
						{#if importResult.success}
							<p class="font-medium text-green-300">
								Import complete! {importResult.imported} of {importResult.total} cards imported.
							</p>
							{#if importResult.mode === 'sync'}
								<p class="text-sm text-green-300/70 mt-1">Collection was replaced (sync mode).</p>
							{:else}
								<p class="text-sm text-green-300/70 mt-1">Cards were added to your collection (append mode).</p>
							{/if}
							{#if importResult.notFound && importResult.notFound > 0}
								<div class="mt-3">
									<p class="text-sm text-yellow-300">
										{importResult.notFound} cards could not be found in the database:
									</p>
									<ul class="text-xs text-yellow-300/70 mt-1 list-disc list-inside max-h-32 overflow-y-auto">
										{#each importResult.notFoundCards ?? [] as card}
											<li>{card}</li>
										{/each}
										{#if importResult.notFound > (importResult.notFoundCards?.length ?? 0)}
											<li>...and {importResult.notFound - (importResult.notFoundCards?.length ?? 0)} more</li>
										{/if}
									</ul>
								</div>
							{/if}
							{#if importResult.parseErrorCount && importResult.parseErrorCount > 0}
								<div class="mt-3">
									<p class="text-sm text-yellow-300">
										{importResult.parseErrorCount} lines could not be parsed:
									</p>
									<ul class="text-xs text-yellow-300/70 mt-1 list-disc list-inside max-h-32 overflow-y-auto font-mono">
										{#each importResult.parseErrors ?? [] as line}
											<li>{line}</li>
										{/each}
										{#if importResult.parseErrorCount > (importResult.parseErrors?.length ?? 0)}
											<li>...and {importResult.parseErrorCount - (importResult.parseErrors?.length ?? 0)} more</li>
										{/if}
									</ul>
								</div>
							{/if}
						{:else}
							<p class="font-medium text-red-300">{importResult.message || 'Import failed.'}</p>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}

<!-- Export Modal -->
{#if showExportModal}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
		onclick={(e) => { if (e.target === e.currentTarget) closeExportModal(); }}
		onkeydown={(e) => { if (e.key === 'Escape') closeExportModal(); }}
	>
		<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] w-full max-w-2xl max-h-[90vh] overflow-y-auto">
			<div class="flex items-center justify-between p-5 border-b border-[var(--color-border)]">
				<h2 class="text-lg font-bold">Export Collection</h2>
				<button onclick={closeExportModal} class="text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-2xl leading-none">&times;</button>
			</div>

			<div class="p-5 space-y-5">
				<!-- Format tabs -->
				<div class="flex gap-1 border-b border-[var(--color-border)]">
					<button
						type="button"
						onclick={() => setExportFormat('csv')}
						class="px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px {exportFormat === 'csv' ? 'border-[var(--color-primary)] text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}"
					>
						Moxfield CSV
					</button>
					<button
						type="button"
						onclick={() => setExportFormat('text')}
						class="px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px {exportFormat === 'text' ? 'border-[var(--color-primary)] text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}"
					>
						Text paste
					</button>
				</div>

				{#if exportFormat === 'csv'}
					<div class="bg-[var(--color-bg)] rounded-lg p-3 border border-[var(--color-border)] text-xs text-[var(--color-text-muted)]">
						Downloads a CSV file compatible with Moxfield's collection import.
					</div>
					<a
						href="/collection/export"
						download="moxfield_collection.csv"
						class="inline-block bg-[var(--color-primary-button)] hover:bg-[var(--color-primary-button-hover)] px-6 py-2.5 rounded-lg font-medium transition-colors"
					>
						Download CSV
					</a>
				{:else}
					<div class="bg-[var(--color-bg)] rounded-lg p-3 border border-[var(--color-border)] text-xs text-[var(--color-text-muted)]">
						Plain-text format: <code>count Name (SET) number</code> with <code>*F*</code> for foils. One line per collection entry.
					</div>
					{#if exportLoading}
						<p class="text-[var(--color-text-muted)] text-sm">Loading...</p>
					{:else}
						<textarea
							readonly
							value={exportText}
							rows="14"
							class="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm font-mono focus:outline-none"
						></textarea>
						<button
							onclick={copyExportText}
							disabled={!exportText}
							class="bg-[var(--color-primary-button)] hover:bg-[var(--color-primary-button-hover)] px-6 py-2.5 rounded-lg font-medium transition-colors disabled:opacity-50"
						>
							{exportCopied ? 'Copied!' : 'Copy to clipboard'}
						</button>
					{/if}
				{/if}
			</div>
		</div>
	</div>
{/if}

<!-- Card Price History Modal -->
{#if modalOpen}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
		onclick={(e) => { if (e.target === e.currentTarget) closeModal(); }}
		onkeydown={(e) => { if (e.key === 'Escape') closeModal(); }}
	>
		<div class="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] w-full max-w-2xl max-h-[80vh] overflow-auto p-6">
			<div class="flex items-center justify-between mb-4">
				<h2 class="text-lg font-semibold">
					{#if modalCard}
						Price History: {modalCard.name}
						<span class="text-sm text-[var(--color-text-muted)] font-normal">({modalCard.set_name})</span>
					{:else}
						Loading...
					{/if}
				</h2>
				<button onclick={closeModal} class="text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-2xl leading-none">&times;</button>
			</div>
			{#if modalLoading}
				<p class="text-[var(--color-text-muted)] text-center py-8">Loading price data...</p>
			{:else if modalCard}
				<canvas bind:this={modalChartCanvas}></canvas>
			{/if}
		</div>
	</div>
{/if}
