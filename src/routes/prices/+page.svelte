<script lang="ts">
	import type { PageData } from './$types';
	import { formatPrice } from '$lib/utils';
	import CardPreview from '$lib/components/CardPreview.svelte';
	import { onMount } from 'svelte';
	import { Chart, registerables } from 'chart.js';

	let { data }: { data: PageData } = $props();

	let cardChartCanvas = $state<HTMLCanvasElement>(null!);
	let profitChartCanvas = $state<HTMLCanvasElement>(null!);
	let cardChart: Chart | null = null;
	let profitChart: Chart | null = null;
	let updating = $state(false);
	let updateMessage = $state('');

	// Card price modal
	let modalOpen = $state(false);
	let modalCard = $state<{ name: string; set_name: string } | null>(null);
	let modalChartCanvas = $state<HTMLCanvasElement>(null!);
	let modalChart: Chart | null = null;
	let modalLoading = $state(false);

	async function openCardChart(cardId: string) {
		modalLoading = true;
		modalOpen = true;
		modalCard = null;
		const res = await fetch(`/api/prices/card?id=${encodeURIComponent(cardId)}`);
		const result = await res.json();
		modalLoading = false;
		if (!result.card) return;
		modalCard = result.card;
		setTimeout(() => {
			if (!modalChartCanvas || !result.history.length) return;
			modalChart?.destroy();
			modalChart = new Chart(modalChartCanvas, {
				type: 'line',
				data: {
					labels: result.history.map((h: Record<string, unknown>) => new Date(h.recorded_at as string).toLocaleDateString()),
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

	async function triggerPriceUpdate() {
		updating = true;
		updateMessage = 'Checking Scryfall for new price data...';
		const res = await fetch('/api/prices', { method: 'POST' });
		const result = await res.json();
		if (result.success) {
			updateMessage = 'New data found, downloading ~500MB...';
			// Poll for completion
			const poll = setInterval(async () => {
				const status = await fetch('/api/prices').then((r) => r.json());
				if (!status.inProgress) {
					clearInterval(poll);
					updating = false;
					if (status.skipped) {
						updateMessage = 'Prices are already up to date (no new Scryfall data).';
					} else {
						updateMessage = 'Prices updated successfully!';
						window.location.reload();
					}
				}
			}, 5000);
		} else {
			updateMessage = result.message;
			updating = false;
		}
	}

	function priceChange(card: Record<string, unknown>): { percent: number; direction: string; color: string } | null {
		const purchasePrice = card.purchase_price as number | null;
		let currentPrice = card.price as number | null;
		// Fallback: convert USD to EUR if no EUR price
		if (currentPrice == null) {
			const usdPrice = card.price_usd as number | null;
			if (usdPrice != null) currentPrice = usdPrice * data.usdToEur;
		}
		if (purchasePrice == null || !purchasePrice || currentPrice == null) return null;
		const percent = ((currentPrice - purchasePrice) / purchasePrice) * 100;
		if (percent > 0) return { percent, direction: '▲', color: 'text-green-400' };
		if (percent < 0) return { percent, direction: '▼', color: 'text-red-400' };
		return { percent: 0, direction: '—', color: 'text-[var(--color-text-muted)]' };
	}

	let totalChange = $derived(
		data.stats.totalPurchaseValue > 0
			? ((data.stats.totalValue - data.stats.totalPurchaseValue) / data.stats.totalPurchaseValue) * 100
			: null
	);


	function formatLastUpdate(dateStr: string | null): string {
		if (!dateStr) return 'Never';
		const d = new Date(dateStr);
		const now = new Date();
		const diffMs = now.getTime() - d.getTime();
		const diffH = Math.floor(diffMs / (1000 * 60 * 60));
		if (diffH < 1) return 'Less than an hour ago';
		if (diffH < 24) return `${diffH} hours ago`;
		const diffD = Math.floor(diffH / 24);
		return `${diffD} day${diffD > 1 ? 's' : ''} ago (${d.toLocaleDateString()})`;
	}

	function buildProfitChart() {
		profitChart?.destroy();
		if (data.profitHistory.length > 0 && profitChartCanvas) {
			const profitData = data.profitHistory.map((h) => ({
				date: new Date(h.recorded_at).toLocaleDateString(),
				profit: (h.total_value ?? 0) - (h.total_purchase ?? 0)
			}));
			profitChart = new Chart(profitChartCanvas, {
				type: 'line',
				data: {
					labels: profitData.map((h) => h.date),
					datasets: [
						{
							label: 'Profit / Loss (EUR)',
							data: profitData.map((h) => h.profit),
							borderColor: profitData.length > 0 && profitData[profitData.length - 1].profit >= 0 ? '#22c55e' : '#ef4444',
							backgroundColor: profitData.length > 0 && profitData[profitData.length - 1].profit >= 0 ? '#22c55e22' : '#ef444422',
							fill: true,
							tension: 0.3
						},
						{
							label: 'Purchase Price (EUR)',
							data: data.profitHistory.map((h) => h.total_purchase),
							borderColor: '#94a3b8',
							borderDash: [5, 5],
							tension: 0.3,
							pointRadius: 0
						},
						{
							label: 'Current Value (EUR)',
							data: data.profitHistory.map((h) => h.total_value),
							borderColor: '#f59e0b',
							tension: 0.3,
							pointRadius: 0
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
		}
	}

	onMount(() => {
		Chart.register(...registerables);
		buildProfitChart();

		// Single card price chart
		if (data.cardPriceHistory.length > 0 && cardChartCanvas) {
			cardChart = new Chart(cardChartCanvas, {
				type: 'line',
				data: {
					labels: data.cardPriceHistory.map((h) => new Date(h.recorded_at as string).toLocaleDateString()),
					datasets: [
						{
							label: 'Price (EUR)',
							data: data.cardPriceHistory.map((h) => h.price_eur as number),
							borderColor: '#3b82f6',
							tension: 0.3
						},
						{
							label: 'Foil Price (EUR)',
							data: data.cardPriceHistory.map((h) => h.price_eur_foil as number),
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
		}

		return () => {
			profitChart?.destroy();
			cardChart?.destroy();
			modalChart?.destroy();
		};
	});
</script>

<div class="space-y-8">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold">Price Tracking</h1>
		<div class="flex items-center gap-3">
			<span class="text-sm text-[var(--color-text-muted)]">
				Last update: {formatLastUpdate(data.priceStatus.lastUpdate)}
			</span>
			<button
				onclick={triggerPriceUpdate}
				disabled={updating || data.priceStatus.inProgress || !data.hasNewData}
				class="bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] px-4 py-1.5 rounded-lg text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
			>
				{updating || data.priceStatus.inProgress ? 'Updating...' : data.hasNewData ? 'Update Prices' : 'Prices up to date'}
			</button>
		</div>
	</div>

	{#if updateMessage}
		<div class="bg-[var(--color-surface)] rounded-lg p-3 border border-[var(--color-border)] text-sm text-[var(--color-text-muted)]">
			{updateMessage}
		</div>
	{/if}

	<!-- Stats -->
	<div class="grid grid-cols-4 gap-4">
		<div class="bg-[var(--color-surface)] rounded-lg p-4 border border-[var(--color-border)]">
			<p class="text-sm text-[var(--color-text-muted)]">Collection Value</p>
			<p class="text-2xl font-bold text-[var(--color-accent)]">{formatPrice(data.stats.totalValue)}</p>
		</div>
		<div class="bg-[var(--color-surface)] rounded-lg p-4 border border-[var(--color-border)]">
			<p class="text-sm text-[var(--color-text-muted)]">Total Purchase Price</p>
			<p class="text-2xl font-bold">{formatPrice(data.stats.totalPurchaseValue)}</p>
			{#if totalChange !== null}
				<p class="text-sm mt-1 {totalChange > 0 ? 'text-green-400' : totalChange < 0 ? 'text-red-400' : 'text-[var(--color-text-muted)]'}">
					{totalChange > 0 ? '▲' : totalChange < 0 ? '▼' : '—'} {Math.abs(totalChange).toFixed(1)}%
				</p>
			{/if}
		</div>
		<div class="bg-[var(--color-surface)] rounded-lg p-4 border border-[var(--color-border)]">
			<p class="text-sm text-[var(--color-text-muted)]">Unique Cards</p>
			<p class="text-2xl font-bold">{data.stats.uniqueCards}</p>
		</div>
		<div class="bg-[var(--color-surface)] rounded-lg p-4 border border-[var(--color-border)]">
			<p class="text-sm text-[var(--color-text-muted)]">Total Cards</p>
			<p class="text-2xl font-bold">{data.stats.totalCards}</p>
		</div>
	</div>

	<!-- Profit / Loss Chart -->
	{#if data.profitHistory.length > 0}
		<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)]">
			<h2 class="text-lg font-semibold mb-4">Profit / Loss</h2>

			{#if data.missingPriceCount > 0}
				<div class="bg-yellow-900/20 border border-yellow-800 rounded-lg p-3 mb-4 text-sm text-yellow-400 flex items-center gap-2">
					<span>⚠</span>
					<span>
						{data.missingPriceCount} card{data.missingPriceCount > 1 ? 's' : ''} in your collection {data.missingPriceCount > 1 ? 'have' : 'has'} no purchase price set.
						<a href="/collection" class="underline hover:text-yellow-300">Set missing prices</a>
					</span>
				</div>
			{/if}

			<canvas bind:this={profitChartCanvas}></canvas>
		</div>
	{:else}
		<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)] text-center text-[var(--color-text-muted)]">
			<p>No price history yet.</p>
			<p class="text-sm mt-1">Prices update automatically once per day, or click "Update Prices" above.</p>
		</div>
	{/if}

	<!-- Single Card Price History -->
	{#if data.selectedCard}
		<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)]">
			<h2 class="text-lg font-semibold mb-4">
				Price History: {data.selectedCard.name}
				<span class="text-sm text-[var(--color-text-muted)] font-normal">({data.selectedCard.set_name})</span>
			</h2>
			{#if data.cardPriceHistory.length > 0}
				<canvas bind:this={cardChartCanvas}></canvas>
			{:else}
				<p class="text-[var(--color-text-muted)]">No price history available for this card.</p>
			{/if}
		</div>
	{/if}

	<!-- Top Cards by Value -->
	{#if data.topCards.length > 0}
		<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)]">
			<h2 class="text-lg font-semibold mb-4">Most Valuable Cards</h2>
			<div class="space-y-2">
				{#each data.topCards as card, i}
					<div class="flex items-center gap-2 p-2 rounded hover:bg-[var(--color-surface-hover)] transition-colors">
						<a
							href="/collection?edit={card.collection_id}"
							class="flex items-center gap-4 flex-1 min-w-0"
						>
							<span class="text-[var(--color-text-muted)] w-6 text-right text-sm">{i + 1}.</span>
							{#if card.image_uri || card.local_image_path}
								<CardPreview src={(card.local_image_path || card.image_uri) as string} alt={card.name as string} scale={3.6}>
									<img
										src={(card.local_image_path || card.image_uri) as string}
										alt={card.name as string}
										class="w-10 h-14 object-cover rounded"
										loading="lazy"
									/>
								</CardPreview>
							{/if}
							<div class="flex-1 min-w-0">
								<p class="font-medium truncate">{card.name}</p>
								<p class="text-xs text-[var(--color-text-muted)]">
									{card.set_name} &middot; {card.quantity}x {#if card.foil}<span class="text-[var(--color-accent)]">FOIL</span>{/if}
								</p>
							</div>
							<div class="text-right flex-shrink-0">
								<span class="text-[var(--color-accent)] font-medium">{formatPrice(card.price as number)}</span>
								{#if priceChange(card)}
									<p class="text-xs {priceChange(card)!.color}">
										{priceChange(card)!.direction} {Math.abs(priceChange(card)!.percent).toFixed(1)}%
									</p>
								{/if}
							</div>
						</a>
						<button
							onclick={() => openCardChart(card.id as string)}
							class="p-2 rounded-lg hover:bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors flex-shrink-0"
							title="Price history"
						>
							<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
								<path stroke-linecap="round" stroke-linejoin="round" d="M3 13l4-4 4 4 4-8 6 6" />
								<path stroke-linecap="round" stroke-linejoin="round" d="M3 20h18" />
							</svg>
						</button>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>

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
