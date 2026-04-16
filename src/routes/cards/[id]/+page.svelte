<script lang="ts">
	import type { PageData } from './$types';
	import { formatManaCost, formatPrice, getRarityColor, conditionLabel, priceDate } from '$lib/utils';
	import { invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import type { Chart } from 'chart.js';
	import { loadChart } from '$lib/chart-loader';

	let { data }: { data: PageData } = $props();

	let addQuantity = $state(1);
	let addCondition = $state('near_mint');
	let addFoil = $state(false);
	let addPurchasePrice = $state('');
	let adding = $state(false);
	let showAddForm = $state(false);

	let card = $derived(data.card);
	let legalities = $derived(card.legalities ? JSON.parse(card.legalities as string) : {});
	let colors: string[] = $derived(card.colors ? JSON.parse(card.colors as string) : []);

	async function addToCollection() {
		adding = true;
		await fetch('/collection', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				cardId: card.id,
				quantity: addQuantity,
				condition: addCondition,
				foil: addFoil,
				purchasePrice: addPurchasePrice ? parseFloat(addPurchasePrice) : null
			})
		});
		adding = false;
		showAddForm = false;
		await invalidateAll();
	}

	async function removeFromCollection(collectionCardId: number) {
		await fetch('/collection', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: collectionCardId })
		});
		await invalidateAll();
	}

	let togglingWishlist = $state(false);

	async function toggleWishlist() {
		togglingWishlist = true;
		if (data.onWishlist) {
			await fetch('/wishlist', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: data.onWishlist.id })
			});
		} else {
			await fetch('/wishlist', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cardId: card.id })
			});
		}
		togglingWishlist = false;
		await invalidateAll();
	}

	function getImageSrc(): string {
		if (card.local_image_path) return card.local_image_path as string;
		if (card.image_uri) return card.image_uri as string;
		return '';
	}

	// Price chart
	let priceChartCanvas = $state<HTMLCanvasElement>(null!);
	let priceChart: Chart | null = null;
	let chartType = $state<'normal' | 'foil'>('normal');

	async function buildPriceChart() {
		priceChart?.destroy();
		priceChart = null;
		if (!priceChartCanvas || data.priceHistory.length === 0) return;
		const ChartCtor = await loadChart();

		const labels = data.priceHistory.map((h) => priceDate(h.recorded_at as string));
		const eurKey = chartType === 'foil' ? 'price_eur_foil' : 'price_eur';
		const usdKey = chartType === 'foil' ? 'price_usd_foil' : 'price_usd';

		const eurData = data.priceHistory.map((h) => h[eurKey] as number | null);
		const usdData = data.priceHistory.map((h) => h[usdKey] as number | null);
		const hasEur = eurData.some((v) => v != null);
		const hasUsd = usdData.some((v) => v != null);

		const datasets: any[] = [];
		if (hasEur) {
			datasets.push({
				label: `Price EUR${chartType === 'foil' ? ' (Foil)' : ''}`,
				data: eurData,
				borderColor: '#f59e0b',
				tension: 0.3,
				spanGaps: true
			});
		}
		if (hasUsd) {
			datasets.push({
				label: `Price USD${chartType === 'foil' ? ' (Foil)' : ''}`,
				data: usdData,
				borderColor: '#3b82f6',
				tension: 0.3,
				spanGaps: true
			});
		}

		priceChart = new ChartCtor(priceChartCanvas, {
			type: 'line',
			data: { labels, datasets },
			options: {
				responsive: true,
				plugins: { legend: { labels: { color: '#b0bec5' } } },
				scales: {
					x: { ticks: { color: '#b0bec5' }, grid: { color: '#334155' } },
					y: { ticks: { color: '#b0bec5' }, grid: { color: '#334155' } }
				}
			}
		});
	}

	function switchChartType(type: 'normal' | 'foil') {
		chartType = type;
		setTimeout(() => buildPriceChart(), 0);
	}

	let metaDescription = $derived.by(() => {
		const parts: string[] = [];
		if (card.type_line) parts.push(card.type_line as string);
		if (card.oracle_text) {
			const text = card.oracle_text as string;
			parts.push(text.length > 100 ? text.slice(0, 100) + '...' : text);
		}
		parts.push(`Set: ${card.set_name}`);
		return parts.join(' - ').slice(0, 155);
	});

	onMount(() => {
		buildPriceChart();
		return () => priceChart?.destroy();
	});
</script>

<svelte:head>
	<title>{card.name} - {card.set_name} | MTG Collector</title>
	<meta name="description" content={metaDescription} />
	<link rel="canonical" href="https://mtg-collector.com/cards/{card.id}" />
	<meta property="og:title" content="{card.name} - {card.set_name}" />
	<meta property="og:description" content={metaDescription} />
	<meta property="og:type" content="product" />
	<meta property="og:url" content="https://mtg-collector.com/cards/{card.id}" />
	{#if getImageSrc()}
		<meta property="og:image" content={getImageSrc()} />
	{/if}
	{@html `<script type="application/ld+json">${JSON.stringify({
		"@context": "https://schema.org",
		"@type": "Product",
		"name": card.name,
		"description": card.oracle_text || card.type_line || "Magic: The Gathering card",
		"image": getImageSrc() || undefined,
		"brand": {
			"@type": "Brand",
			"name": "Magic: The Gathering"
		},
		"category": card.type_line || undefined,
		"offers": card.price_eur ? {
			"@type": "Offer",
			"priceCurrency": "EUR",
			"price": (card.price_eur as number).toFixed(2),
			"availability": "https://schema.org/InStock"
		} : undefined,
		"additionalProperty": [
			{ "@type": "PropertyValue", "name": "Set", "value": card.set_name },
			{ "@type": "PropertyValue", "name": "Rarity", "value": card.rarity },
			{ "@type": "PropertyValue", "name": "Collector Number", "value": card.collector_number }
		].filter(Boolean)
	})}</script>`}
</svelte:head>

<article class="space-y-6">
	<a href="/cards" class="text-[var(--color-primary)] hover:underline text-sm">&larr; Back to cards</a>

	<div class="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4 md:gap-8">
		<!-- Card Image -->
		<div>
			{#if getImageSrc()}
				<img src={getImageSrc()} alt="Magic: The Gathering - {card.name} ({card.set_name})" width="488" height="680" class="w-full rounded-lg shadow-lg aspect-[488/680] object-cover" loading="eager" fetchpriority="high" />
			{:else}
				<div class="w-full aspect-[488/680] bg-[var(--color-surface)] rounded-lg flex items-center justify-center text-[var(--color-text-muted)]">
					No image
				</div>
			{/if}

			<!-- Multi-face images -->
			{#if data.faces.length > 1}
				<div class="mt-4 grid grid-cols-2 gap-2">
					{#each data.faces as face}
						{#if face.image_uri}
							<img src={face.image_uri as string} alt="Magic: The Gathering - {face.name}" width="488" height="680" class="w-full rounded aspect-[488/680] object-cover" loading="lazy" />
						{/if}
					{/each}
				</div>
			{/if}
		</div>

		<!-- Card Details -->
		<section class="space-y-6">
			<div>
				<h1 class="text-3xl font-bold">{card.name}</h1>
				<div class="flex items-center gap-3 mt-2">
					{#if card.mana_cost}
						<span class="text-lg">{formatManaCost(card.mana_cost as string)}</span>
					{/if}
					<span class="px-2 py-0.5 rounded text-xs font-semibold" style="background: {getRarityColor(card.rarity as string)}; color: white;">
						{(card.rarity as string).toUpperCase()}
					</span>
				</div>
			</div>

			<div class="bg-[var(--color-surface)] rounded-lg p-4 border border-[var(--color-border)] space-y-3">
				{#if card.type_line}
					<p class="font-medium">{card.type_line}</p>
				{/if}
				{#if card.oracle_text}
					<p class="text-[var(--color-text-muted)] whitespace-pre-line">{card.oracle_text}</p>
				{/if}
				{#if card.power && card.toughness}
					<p class="font-bold text-lg">{card.power}/{card.toughness}</p>
				{/if}
				{#if card.loyalty}
					<p class="font-bold text-lg">Loyalty: {card.loyalty}</p>
				{/if}
			</div>

			<!-- Multi-face details -->
			{#if data.faces.length > 1}
				{#each data.faces as face, i}
					<div class="bg-[var(--color-surface)] rounded-lg p-4 border border-[var(--color-border)]">
						<h3 class="font-semibold mb-2">Face {i + 1}: {face.name}</h3>
						{#if face.mana_cost}
							<p class="text-sm">{formatManaCost(face.mana_cost as string)}</p>
						{/if}
						{#if face.type_line}
							<p class="text-sm font-medium mt-1">{face.type_line}</p>
						{/if}
						{#if face.oracle_text}
							<p class="text-sm text-[var(--color-text-muted)] mt-1 whitespace-pre-line">{face.oracle_text}</p>
						{/if}
					</div>
				{/each}
			{/if}

			<!-- Info Grid -->
			<div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
				<div class="bg-[var(--color-surface)] rounded p-3 border border-[var(--color-border)]">
					<span class="text-[var(--color-text-muted)]">Set</span>
					<p class="font-medium">{card.set_name} ({(card.set_code as string).toUpperCase()})</p>
				</div>
				<div class="bg-[var(--color-surface)] rounded p-3 border border-[var(--color-border)]">
					<span class="text-[var(--color-text-muted)]">Collector #</span>
					<p class="font-medium">{card.collector_number}</p>
				</div>
				<div class="bg-[var(--color-surface)] rounded p-3 border border-[var(--color-border)]">
					<span class="text-[var(--color-text-muted)]">Price</span>
					<p class="font-medium text-[var(--color-accent)]">{formatPrice(card.price_eur as number | null, card.price_usd as number | null)}</p>
				</div>
				<div class="bg-[var(--color-surface)] rounded p-3 border border-[var(--color-border)]">
					<span class="text-[var(--color-text-muted)]">Price Foil</span>
					<p class="font-medium text-[var(--color-accent)]">{formatPrice(card.price_eur_foil as number | null, card.price_usd_foil as number | null)}</p>
				</div>
			</div>

			<!-- Price History Chart -->
			{#if data.priceHistory.length > 0}
				<div class="bg-[var(--color-surface)] rounded-lg p-4 border border-[var(--color-border)]">
					<div class="flex items-center justify-between mb-3">
						<h3 class="font-semibold">Price History</h3>
						<div class="flex gap-1 bg-[var(--color-bg)] rounded-lg p-0.5">
							<button
								onclick={() => switchChartType('normal')}
								class="px-3 py-1 rounded-md text-xs transition-colors {chartType === 'normal' ? 'bg-[var(--color-primary-button)] text-white' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}"
							>
								Normal
							</button>
							<button
								onclick={() => switchChartType('foil')}
								class="px-3 py-1 rounded-md text-xs transition-colors {chartType === 'foil' ? 'bg-[var(--color-primary-button)] text-white' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}"
							>
								Foil
							</button>
						</div>
					</div>
					<canvas bind:this={priceChartCanvas}></canvas>
				</div>
			{/if}

			<!-- Colors -->
			{#if colors.length > 0}
				<div class="flex gap-2">
					{#each colors as color}
						<span class="px-3 py-1 rounded-full text-sm font-medium
							{color === 'W' ? 'bg-yellow-100 text-yellow-800' : ''}
							{color === 'U' ? 'bg-blue-400 text-blue-900' : ''}
							{color === 'B' ? 'bg-gray-700 text-gray-100' : ''}
							{color === 'R' ? 'bg-red-500 text-red-100' : ''}
							{color === 'G' ? 'bg-green-500 text-green-100' : ''}
						">{color}</span>
					{/each}
				</div>
			{/if}

			<!-- Legalities -->
			<div>
				<h3 class="text-sm text-[var(--color-text-muted)] mb-2">Legalities</h3>
				<div class="flex flex-wrap gap-2">
					{#each Object.entries(legalities) as [format, status]}
						<span class="px-2 py-0.5 rounded text-xs {status === 'legal' ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-500'}">
							{format}
						</span>
					{/each}
				</div>
			</div>

			<!-- Wishlist Button -->
			<button
				onclick={toggleWishlist}
				disabled={togglingWishlist}
				class="w-full py-2 rounded-lg text-sm border transition-colors disabled:opacity-50 {data.onWishlist ? 'bg-yellow-600/20 border-yellow-600 text-yellow-400 hover:bg-yellow-600/30' : 'bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-yellow-600'}"
			>
				{data.onWishlist ? '★ On Wishlist' : '☆ Add to Wishlist'}
			</button>

			<!-- Collection Section -->
			<aside class="bg-[var(--color-surface)] rounded-lg p-4 border border-[var(--color-border)]">
				<div class="flex items-center justify-between mb-3">
					<h3 class="font-semibold">Collection</h3>
					<button
						onclick={() => showAddForm = !showAddForm}
						class="bg-[var(--color-primary-button)] hover:bg-[var(--color-primary-button-hover)] px-3 py-1.5 rounded text-sm transition-colors"
					>
						+ Add to Collection
					</button>
				</div>

				{#if showAddForm}
					<div class="bg-[var(--color-bg)] rounded p-4 mb-3 space-y-3">
						<div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
							<div>
								<label for="add-qty" class="block text-xs text-[var(--color-text-muted)] mb-1">Quantity</label>
								<input id="add-qty" type="number" bind:value={addQuantity} min="1" class="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-2 py-1" />
							</div>
							<div>
								<label for="add-condition" class="block text-xs text-[var(--color-text-muted)] mb-1">Condition</label>
								<select id="add-condition" bind:value={addCondition} class="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-2 py-1">
									<option value="near_mint">Near Mint</option>
									<option value="lightly_played">Lightly Played</option>
									<option value="moderately_played">Moderately Played</option>
									<option value="heavily_played">Heavily Played</option>
									<option value="damaged">Damaged</option>
								</select>
							</div>
							<div class="flex items-end">
								<label class="flex items-center gap-2">
									<input type="checkbox" bind:checked={addFoil} class="rounded" />
									<span class="text-sm">Foil</span>
								</label>
							</div>
						</div>
						<div>
							<label for="add-purchase-price" class="block text-xs text-[var(--color-text-muted)] mb-1">Purchase Price (EUR)</label>
							<input
								id="add-purchase-price"
								type="number"
								bind:value={addPurchasePrice}
								step="0.01"
								min="0"
								placeholder="e.g. 3.50"
								class="w-48 bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-2 py-1 focus:outline-none focus:border-[var(--color-primary)]"
							/>
						</div>
						<button
							onclick={addToCollection}
							disabled={adding}
							class="bg-green-600 hover:bg-green-700 px-4 py-1.5 rounded text-sm transition-colors disabled:opacity-50"
						>
							{adding ? 'Adding...' : 'Confirm'}
						</button>
					</div>
				{/if}

				{#if data.inCollection.length > 0}
					<div class="space-y-2">
						{#each data.inCollection as entry}
							<div class="flex items-center justify-between bg-[var(--color-bg)] rounded px-3 py-2">
								<div class="flex items-center gap-3 text-sm">
									<span class="font-medium">{entry.quantity}x</span>
									<span class="text-[var(--color-text-muted)]">{conditionLabel(entry.condition as string)}</span>
									{#if entry.foil}
										<span class="text-[var(--color-accent)] text-xs">FOIL</span>
									{/if}
								</div>
								<button
									onclick={() => removeFromCollection(entry.id as number)}
									class="text-red-400 hover:text-red-300 text-sm"
								>
									Remove
								</button>
							</div>
						{/each}
					</div>
				{:else}
					<p class="text-sm text-[var(--color-text-muted)]">Not in your collection yet.</p>
				{/if}
			</aside>

			<!-- Reprints -->
			{#if data.reprints.length > 0}
				<div>
					<h3 class="text-sm text-[var(--color-text-muted)] mb-2">Other Printings ({data.reprints.length})</h3>
					<div class="flex flex-wrap gap-2">
						{#each data.reprints as reprint}
							<a
								href="/cards/{reprint.id}"
								class="bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-1.5 text-sm hover:border-[var(--color-primary)] transition-colors"
							>
								{reprint.set_name} #{reprint.collector_number}
								{#if reprint.price_eur || reprint.price_usd}
									<span class="text-[var(--color-accent)] ml-1">{formatPrice(reprint.price_eur as number | null, reprint.price_usd as number | null)}</span>
								{/if}
							</a>
						{/each}
					</div>
				</div>
			{/if}
		</section>
	</div>
</article>
