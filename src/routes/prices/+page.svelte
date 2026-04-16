<script lang="ts">
	import type { PageData } from './$types';
	import { formatPrice, priceDate } from '$lib/utils';
	import CardPreview from '$lib/components/CardPreview.svelte';
	import type { Chart } from 'chart.js';
	import { loadChart } from '$lib/chart-loader';

	let { data }: { data: PageData } = $props();

	// Data loaded client-side
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let topCards = $state<Array<Record<string, unknown>>>([]);
	let stats = $state({ totalValue: 0, totalPurchaseValue: 0, uniqueCards: 0, totalCards: 0 });
	let missingPriceCount = $state(0);
	let profitHistory = $state<Array<{ recorded_at: string; total_value: number; total_purchase: number }>>([]);
	let usdToEur = $state(0.92);

	let profitChartCanvas = $state<HTMLCanvasElement>(null!);
	let profitChart: Chart | null = null;

	// Card price modal
	let modalOpen = $state(false);
	let modalCard = $state<{ name: string; set_name: string } | null>(null);
	let modalChartCanvas = $state<HTMLCanvasElement>(null!);
	let modalChart: Chart | null = null;
	let modalLoading = $state(false);

	async function loadPricesData() {
		loading = true;
		loadError = null;
		try {
			const res = await fetch('/api/prices/data');
			if (!res.ok) {
				loadError = `Failed to load price data (HTTP ${res.status}).`;
				return;
			}
			const result = await res.json();
			topCards = result.topCards;
			stats = result.stats;
			missingPriceCount = result.missingPriceCount;
			profitHistory = result.profitHistory;
			usdToEur = result.usdToEur;
		} catch (err) {
			loadError = err instanceof Error ? err.message : 'Failed to load price data.';
		} finally {
			loading = false;
		}
	}

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
					plugins: { legend: { labels: { color: '#b0bec5' } } },
					scales: {
						x: { ticks: { color: '#b0bec5' }, grid: { color: '#334155' } },
						y: { ticks: { color: '#b0bec5', callback: (v) => `€${v}` }, grid: { color: '#334155' } }
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

	function currentPrice(card: Record<string, unknown>): number | null {
		const price = card.price as number | null;
		const priceUsd = card.price_usd as number | null;
		return price ?? (priceUsd != null ? priceUsd * usdToEur : null);
	}

	function prevPrice(card: Record<string, unknown>): number | null {
		const price = card.prev_price as number | null;
		const priceUsd = card.prev_price_usd as number | null;
		return price ?? (priceUsd != null ? priceUsd * usdToEur : null);
	}

	function cardValue(card: Record<string, unknown>): number {
		return (currentPrice(card) ?? 0) * (card.quantity as number);
	}

	function cardProfit(card: Record<string, unknown>): number | null {
		const base = changeMode === 'purchase' ? card.purchase_price as number | null : prevPrice(card);
		if (base == null || !base) return null;
		const cur = currentPrice(card);
		if (cur == null) return null;
		return (cur - base) * (card.quantity as number);
	}

	function cardProfitPct(card: Record<string, unknown>): number | null {
		const base = changeMode === 'purchase' ? card.purchase_price as number | null : prevPrice(card);
		if (base == null || !base) return null;
		const cur = currentPrice(card);
		if (cur == null) return null;
		return ((cur - base) / base) * 100;
	}

	function priceChange(card: Record<string, unknown>): { percent: number; direction: string; color: string } | null {
		const pct = cardProfitPct(card);
		if (pct == null) return null;
		if (pct > 0) return { percent: pct, direction: '▲', color: 'text-green-400' };
		if (pct < 0) return { percent: pct, direction: '▼', color: 'text-red-400' };
		return { percent: 0, direction: '—', color: 'text-[var(--color-text-muted)]' };
	}

	let topSort = $state<'value' | 'profit' | 'profit_pct'>('value');
	let changeMode = $state<'purchase' | 'daily'>('purchase');

	let sortedTopCards = $derived.by(() => {
		const cards = [...topCards];
		if (topSort === 'value') {
			cards.sort((a, b) => cardValue(b) - cardValue(a));
		} else if (topSort === 'profit') {
			cards.sort((a, b) => (cardProfit(b) ?? -Infinity) - (cardProfit(a) ?? -Infinity));
		} else {
			cards.sort((a, b) => (cardProfitPct(b) ?? -Infinity) - (cardProfitPct(a) ?? -Infinity));
		}
		return cards.slice(0, 20);
	});

	let totalChange = $derived(
		stats.totalPurchaseValue > 0
			? ((stats.totalValue - stats.totalPurchaseValue) / stats.totalPurchaseValue) * 100
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

	async function buildProfitChart() {
		profitChart?.destroy();
		if (profitHistory.length > 0 && profitChartCanvas) {
			const ChartCtor = await loadChart();
			const profitData = profitHistory.map((h) => ({
				date: priceDate(h.recorded_at),
				profit: (h.total_value ?? 0) - (h.total_purchase ?? 0)
			}));
			profitChart = new ChartCtor(profitChartCanvas, {
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
							data: profitHistory.map((h) => h.total_purchase),
							borderColor: '#b0bec5',
							borderDash: [5, 5],
							tension: 0.3,
							pointRadius: 0
						},
						{
							label: 'Current Value (EUR)',
							data: profitHistory.map((h) => h.total_value),
							borderColor: '#f59e0b',
							tension: 0.3,
							pointRadius: 0
						}
					]
				},
				options: {
					responsive: true,
					plugins: { legend: { labels: { color: '#b0bec5' } } },
					scales: {
						x: { ticks: { color: '#b0bec5' }, grid: { color: '#334155' } },
						y: { ticks: { color: '#b0bec5', callback: (v) => `€${v}` }, grid: { color: '#334155' } }
					}
				}
			});
		}
	}

	$effect(() => {
		loadPricesData().then(() => {
			// Build chart after data is loaded (need to wait a tick for canvas
			// to render). Chart.js itself is loaded lazily inside buildProfitChart.
			setTimeout(() => buildProfitChart(), 0);
		});

		return () => {
			profitChart?.destroy();
			modalChart?.destroy();
		};
	});
</script>

<svelte:head>
	<title>Price Tracking | MTG Collector</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="space-y-8">
	<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
		<h1 class="text-2xl font-bold">Price Tracking</h1>
		<span class="text-sm text-[var(--color-text-muted)]">
			Last update: {formatLastUpdate(data.priceStatus.lastUpdate)}
		</span>
	</div>

	{#if loadError}
		<div class="bg-red-500/10 border border-red-500/40 text-red-300 rounded-lg px-4 py-3 flex items-center justify-between gap-4">
			<span>{loadError}</span>
			<button class="underline" onclick={() => loadPricesData()}>Retry</button>
		</div>
	{/if}

	{#if loading}
		<!-- Loading skeleton -->
		<div class="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4">
			{#each Array(4) as _}
				<div class="bg-[var(--color-surface)] rounded-lg p-4 border border-[var(--color-border)] animate-pulse">
					<div class="h-4 bg-[var(--color-bg)] rounded w-24 mb-2"></div>
					<div class="h-8 bg-[var(--color-bg)] rounded w-20"></div>
				</div>
			{/each}
		</div>

		<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)] animate-pulse">
			<div class="h-5 bg-[var(--color-bg)] rounded w-32 mb-4"></div>
			<div style="aspect-ratio: 2/1;" class="bg-[var(--color-bg)] rounded"></div>
		</div>

		<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)] animate-pulse">
			<div class="h-5 bg-[var(--color-bg)] rounded w-40 mb-4"></div>
			<div class="space-y-3">
				{#each Array(5) as _}
					<div class="flex items-center gap-4 p-2">
						<div class="w-6 h-4 bg-[var(--color-bg)] rounded"></div>
						<div class="w-10 h-14 bg-[var(--color-bg)] rounded"></div>
						<div class="flex-1">
							<div class="h-4 bg-[var(--color-bg)] rounded w-48 mb-1"></div>
							<div class="h-3 bg-[var(--color-bg)] rounded w-32"></div>
						</div>
						<div class="h-5 bg-[var(--color-bg)] rounded w-16"></div>
					</div>
				{/each}
			</div>
		</div>
	{:else}
		<!-- Stats -->
		<div class="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4">
			<div class="bg-[var(--color-surface)] rounded-lg p-3 sm:p-4 border border-[var(--color-border)] min-w-0">
				<p class="text-xs sm:text-sm text-[var(--color-text-muted)]">Collection Value</p>
				<p class="text-xl sm:text-2xl font-bold text-[var(--color-accent)] break-words">{formatPrice(stats.totalValue)}</p>
			</div>
			<div class="bg-[var(--color-surface)] rounded-lg p-3 sm:p-4 border border-[var(--color-border)] min-w-0">
				<p class="text-xs sm:text-sm text-[var(--color-text-muted)]">Total Purchase Price</p>
				<p class="text-xl sm:text-2xl font-bold break-words">{formatPrice(stats.totalPurchaseValue)}</p>
				{#if totalChange !== null}
					<p class="text-sm mt-1 {totalChange > 0 ? 'text-green-400' : totalChange < 0 ? 'text-red-400' : 'text-[var(--color-text-muted)]'}">
						{totalChange > 0 ? '▲' : totalChange < 0 ? '▼' : '—'} {Math.abs(totalChange).toFixed(1)}%
					</p>
				{/if}
			</div>
			<div class="bg-[var(--color-surface)] rounded-lg p-3 sm:p-4 border border-[var(--color-border)] min-w-0">
				<p class="text-xs sm:text-sm text-[var(--color-text-muted)]">Unique Cards</p>
				<p class="text-xl sm:text-2xl font-bold break-words">{stats.uniqueCards}</p>
			</div>
			<div class="bg-[var(--color-surface)] rounded-lg p-3 sm:p-4 border border-[var(--color-border)] min-w-0">
				<p class="text-xs sm:text-sm text-[var(--color-text-muted)]">Total Cards</p>
				<p class="text-xl sm:text-2xl font-bold break-words">{stats.totalCards}</p>
			</div>
		</div>

		<!-- Profit / Loss Chart -->
		{#if profitHistory.length > 0}
			<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)]">
				<h2 class="text-lg font-semibold mb-4">Profit / Loss</h2>

				{#if missingPriceCount > 0}
					<div class="bg-yellow-900/20 border border-yellow-800 rounded-lg p-3 mb-4 text-sm text-yellow-400 flex items-center gap-2">
						<span>⚠</span>
						<span>
							{missingPriceCount} card{missingPriceCount > 1 ? 's' : ''} in your collection {missingPriceCount > 1 ? 'have' : 'has'} no purchase price set.
							<a href="/collection" class="underline hover:text-yellow-300">Set missing prices</a>
						</span>
					</div>
				{/if}

				<div style="position: relative; width: 100%; aspect-ratio: 2/1;">
					<canvas bind:this={profitChartCanvas}></canvas>
				</div>
			</div>
		{:else}
			<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)] text-center text-[var(--color-text-muted)]">
				<p>No price history yet.</p>
				<p class="text-sm mt-1">Prices update automatically once per day, or click "Update Prices" above.</p>
			</div>
		{/if}

		<!-- Top Cards -->
		{#if topCards.length > 0}
			<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)]">
				<div class="flex items-center justify-between mb-4 flex-wrap gap-2">
					<h2 class="text-lg font-semibold">
						{topSort === 'value' ? 'Most Valuable Cards' : topSort === 'profit' ? 'Top Profit Cards' : 'Top Profit Cards (%)'}
					</h2>
					<div class="flex items-center gap-3">
						{#if topSort !== 'value'}
							<div class="flex gap-1 bg-[var(--color-bg)] rounded-lg p-1">
								<button
									onclick={() => changeMode = 'purchase'}
									class="px-2 py-0.5 rounded text-xs transition-colors {changeMode === 'purchase' ? 'bg-[var(--color-primary-button)] text-white' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}"
								>vs. Purchase</button>
								<button
									onclick={() => changeMode = 'daily'}
									class="px-2 py-0.5 rounded text-xs transition-colors {changeMode === 'daily' ? 'bg-[var(--color-primary-button)] text-white' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}"
								>vs. Yesterday</button>
							</div>
						{/if}
						<div class="flex gap-1 bg-[var(--color-bg)] rounded-lg p-1">
							<button
								onclick={() => topSort = 'value'}
								class="px-3 py-1 rounded text-sm transition-colors {topSort === 'value' ? 'bg-[var(--color-primary-button)] text-white' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}"
							>Value</button>
							<button
								onclick={() => topSort = 'profit'}
								class="px-3 py-1 rounded text-sm transition-colors {topSort === 'profit' ? 'bg-[var(--color-primary-button)] text-white' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}"
							>Profit</button>
							<button
								onclick={() => topSort = 'profit_pct'}
								class="px-3 py-1 rounded text-sm transition-colors {topSort === 'profit_pct' ? 'bg-[var(--color-primary-button)] text-white' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}"
							>Profit %</button>
						</div>
					</div>
				</div>
				<div class="space-y-2">
					{#each sortedTopCards as card, i}
						<div class="flex items-center gap-2 p-2 rounded hover:bg-[var(--color-surface-hover)] transition-colors">
							<a
								href="/collection?edit={card.collection_id}"
								class="flex items-center gap-2 sm:gap-4 flex-1 min-w-0"
							>
								<span class="text-[var(--color-text-muted)] w-5 sm:w-6 text-right text-xs sm:text-sm flex-shrink-0">{i + 1}.</span>
								{#if card.image_uri || card.local_image_path}
									<CardPreview src={(card.local_image_path || card.image_uri) as string} alt={card.name as string} scale={2.4}>
										<img
											src={(card.local_image_path || card.image_uri) as string}
											alt={card.name as string}
											class="w-8 h-12 sm:w-10 sm:h-14 object-cover rounded flex-shrink-0"
											loading="lazy"
										/>
									</CardPreview>
								{/if}
								<div class="flex-1 min-w-0">
									<p class="font-medium truncate text-sm sm:text-base">{card.name}</p>
									<p class="text-xs text-[var(--color-text-muted)] truncate">
										{card.set_name} &middot; {card.quantity}x {#if card.foil}<span class="text-[var(--color-accent)]">FOIL</span>{/if}
									</p>
								</div>
								<div class="text-right flex-shrink-0">
									{#if topSort === 'value'}
										<span class="text-[var(--color-accent)] font-medium">{formatPrice(card.price as number)}</span>
										{#if priceChange(card)}
											<p class="text-xs {priceChange(card)!.color}">
												{priceChange(card)!.direction} {Math.abs(priceChange(card)!.percent).toFixed(1)}%
											</p>
										{/if}
									{:else if topSort === 'profit'}
										{@const profit = cardProfit(card)}
										{#if profit != null}
											<span class="font-medium {profit >= 0 ? 'text-green-400' : 'text-red-400'}">
												{profit >= 0 ? '+' : ''}{formatPrice(profit)}
											</span>
										{/if}
										<p class="text-xs text-[var(--color-text-muted)]">{formatPrice(card.price as number)}</p>
									{:else}
										{@const pct = cardProfitPct(card)}
										{#if pct != null}
											<span class="font-medium {pct >= 0 ? 'text-green-400' : 'text-red-400'}">
												{pct >= 0 ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}%
											</span>
										{/if}
										<p class="text-xs text-[var(--color-text-muted)]">{formatPrice(card.price as number)}</p>
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
	{/if}
</div>

<!-- Card Price History Modal -->
{#if modalOpen}
	<div
		class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
		role="dialog"
		aria-modal="true"
		aria-label="Card price history"
		tabindex="-1"
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
				<div style="position: relative; width: 100%; aspect-ratio: 2/1;">
					<canvas bind:this={modalChartCanvas}></canvas>
				</div>
			{/if}
		</div>
	</div>
{/if}
