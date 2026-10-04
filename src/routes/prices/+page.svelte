<script lang="ts">
	import type { PageData } from './$types';
	import { formatPrice, priceDate, histEur } from '$lib/utils';
	import CardPreview from '$lib/components/CardPreview.svelte';
	import type { Chart } from 'chart.js';
	import { loadChart } from '$lib/chart-loader';
	import { onMount, tick } from 'svelte';
	import type { ProfitPoint } from '$lib/server/price-data';

	let { data }: { data: PageData } = $props();

	// Data loaded client-side
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let topCards = $state<Array<Record<string, unknown>>>([]);
	let stats = $state({ totalValue: 0, totalPurchaseValue: 0, profitValue: 0, profitCost: 0, profitCopies: 0, uniqueCards: 0, totalCards: 0 });
	let missingPriceCount = $state(0);
	let missingMarketCount = $state(0);
	let estimatedCount = $state(0);
	let profitHistory = $state<ProfitPoint[]>([]);
	let chartError = $state<string | null>(null);
	let active = false;
	let usdToEur = $state(0.92);

	// One-time repair after a collection re-sync reset every card's added_at.
	let restoring = $state(false);
	let restoreMessage = $state<string | null>(null);

	let profitChartCanvas = $state<HTMLCanvasElement>(null!);
	let profitChart: Chart | null = null;

	// Card price modal
	let modalOpen = $state(false);
	let modalCard = $state<{ name: string; set_name: string } | null>(null);
	let modalChartCanvas = $state<HTMLCanvasElement>(null!);
	let modalChart: Chart | null = null;
	let modalLoading = $state(false);
	let modalError = $state<string | null>(null);
	let modalEmpty = $state(false);
	let modalEstimated = $state(false);
	let modalRequest = 0;

	async function loadPricesData() {
		loading = true;
		loadError = null;
		try {
			const res = await fetch('/api/prices/data', { cache: 'no-store' });
			if (!res.ok) {
				loadError = `Failed to load price data (HTTP ${res.status}).`;
				return;
			}
			const result = await res.json();
			topCards = result.topCards;
			stats = result.stats;
			missingPriceCount = result.missingPriceCount;
			missingMarketCount = result.missingMarketCount;
			estimatedCount = result.estimatedCount;
			profitHistory = result.profitHistory;
			usdToEur = result.usdToEur;
		} catch (err) {
			loadError = err instanceof Error ? err.message : 'Failed to load price data.';
		} finally {
			loading = false;
			await tick();
			if (!loadError && active) {
				chartError = null;
				try { await buildProfitChart(); }
				catch { chartError = 'The chart could not be loaded. Your totals are still available.'; }
			}
		}
	}

	// Backdate the collection's added_at to the earliest available price snapshot
	// per card, so the value/profit chart fills back in after a collection
	// re-sync reset every card to "added today". Only moves dates earlier.
	async function restoreHistory() {
		if (
			!confirm(
				'Re-sync fix: backdate every card in your collection to the earliest date price data exists for it, so the chart below fills back in. This only changes the "added" date (cards already dated earlier stay untouched) — quantities, purchase prices and tags are not affected. Continue?'
			)
		) {
			return;
		}
		restoring = true;
		restoreMessage = null;
		loadError = null;
		try {
			const res = await fetch('/api/collection/restore-history', { method: 'POST' });
			if (!res.ok) {
				loadError = `Failed to restore history (HTTP ${res.status}).`;
				return;
			}
			const result = await res.json();
			restoreMessage =
				result.updated > 0
					? `Backdated ${result.updated} card${result.updated === 1 ? '' : 's'}. History refreshed below.`
					: 'Nothing to restore — your cards are already dated as early as the available price data.';
			await loadPricesData();
		} catch (err) {
			loadError = err instanceof Error ? err.message : 'Failed to restore history.';
		} finally {
			restoring = false;
		}
	}

	async function openCardChart(cardId: string, lang: string = 'en') {
		const request = ++modalRequest;
		modalLoading = true;
		modalOpen = true;
		modalCard = null;
		modalError = null;
		modalEmpty = false;
		modalEstimated = false;
		modalChart?.destroy();
		modalChart = null;
		try {
			const [res, ChartCtor] = await Promise.all([
				fetch(`/api/prices/card?id=${encodeURIComponent(cardId)}&lang=${encodeURIComponent(lang)}`, { cache: 'no-store' }),
				loadChart()
			]);
			if (!res.ok) throw new Error(`Price history unavailable (HTTP ${res.status}).`);
			const result = await res.json();
			if (!active || request !== modalRequest) return;
			modalCard = result.card;
			modalEstimated = result.fallbackUsed;
			modalEmpty = !result.history.length;
			modalLoading = false;
			await tick();
			if (request !== modalRequest || !modalChartCanvas?.isConnected || modalEmpty) return;
			modalChart = new ChartCtor(modalChartCanvas, {
				type: 'line',
				data: {
					labels: result.history.map((h: Record<string, unknown>) => priceDate(h.recorded_at as string)),
					datasets: [
						{
							label: 'Price (EUR)',
							data: result.history.map((h: Record<string, unknown>) => histEur(h.price_eur as number | null, h.price_usd as number | null, usdToEur)),
							borderColor: '#3b82f6',
							tension: 0.3
						},
						{
							label: 'Foil Price (EUR)',
							data: result.history.map((h: Record<string, unknown>) => histEur(h.price_eur_foil as number | null, h.price_usd_foil as number | null, usdToEur)),
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
		} catch (err) {
			if (active && request === modalRequest) modalError = err instanceof Error ? err.message : 'Price history unavailable.';
		} finally {
			if (active && request === modalRequest) modalLoading = false;
		}
	}

	function closeModal() {
		modalRequest++;
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
		if (base == null) return null;
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
		stats.profitCost > 0
			? ((stats.profitValue - stats.profitCost) / stats.profitCost) * 100
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
		profitChart = null;
		if (profitHistory.length > 0 && profitChartCanvas) {
			const ChartCtor = await loadChart();
			if (!active || !profitChartCanvas?.isConnected) return;
			const profitData = profitHistory.map((h) => ({
				date: priceDate(h.recorded_at),
				profit: h.total_value == null || h.total_purchase == null ? null : h.total_value - h.total_purchase
			}));
			profitChart = new ChartCtor(profitChartCanvas, {
				type: 'line',
				data: {
					labels: profitData.map((h) => h.date),
					datasets: [
						{
							label: 'Profit / Loss (EUR)',
							data: profitData.map((h) => h.profit),
							borderColor: (profitData.at(-1)?.profit ?? 0) >= 0 ? '#22c55e' : '#ef4444',
							backgroundColor: (profitData.at(-1)?.profit ?? 0) >= 0 ? '#22c55e22' : '#ef444422',
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
							label: 'Market Value (EUR)',
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

	onMount(() => {
		active = true;
		void loadPricesData();

		return () => {
			active = false;
			modalRequest++;
			profitChart?.destroy();
			modalChart?.destroy();
		};
	});
</script>

<svelte:head>
	<title>Price Tracking | MTG Collector</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="space-y-5">
	<div class="page-heading">
		<div>
			<p class="eyebrow">Portfolio analytics</p>
			<h1 class="mt-1 text-[22px] font-semibold text-[var(--color-text-strong)]">Price Tracking</h1>
		</div>
		<span class="chip">
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
		<div class="grid grid-cols-2 gap-3 md:grid-cols-4">
			{#each Array(4) as _}
				<div class="kpi-card">
					<div class="skeleton mb-2 h-4 w-24 rounded"></div>
					<div class="skeleton h-8 w-20 rounded"></div>
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
	{:else if !loadError}
		{#snippet restoreControl()}
			<button
				onclick={restoreHistory}
				disabled={restoring}
				class="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-primary)] transition-colors disabled:opacity-50 inline-flex items-center gap-1.5 flex-shrink-0"
				title="Backdate collection cards to the earliest date price data exists for them — restores a chart that a collection re-sync truncated to today"
			>
				<svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h5M20 20v-5h-5" />
					<path stroke-linecap="round" stroke-linejoin="round" d="M20 9a8 8 0 00-14.9-3M4 15a8 8 0 0014.9 3" />
				</svg>
				{restoring ? 'Restoring…' : 'Restore history after re-sync'}
			</button>
		{/snippet}

		<!-- Stats -->
		<div class="grid grid-cols-2 gap-3 md:grid-cols-4">
			<div class="kpi-card">
				<p class="kpi-label">Collection Value</p>
				<p class="kpi-value text-[var(--color-accent)]">{formatPrice(stats.totalValue)}</p>
			</div>
			<div class="kpi-card">
				<p class="kpi-label">Known Cost Basis</p>
				<p class="kpi-value">{formatPrice(stats.totalPurchaseValue)}</p>
			</div>
			<div class="kpi-card">
				<p class="kpi-label">Unique Printings</p>
				<p class="kpi-value">{stats.uniqueCards}</p>
			</div>
			<div class="kpi-card">
				<p class="kpi-label">Total Cards</p>
				<p class="kpi-value">{stats.totalCards}</p>
			</div>
		</div>

		<!-- Profit / Loss Chart -->
		{#if stats.profitCopies > 0}
			{@const profit = stats.profitValue - stats.profitCost}
			<div class="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-4">
				<p class="font-medium">Profit / Loss:
					<span class={profit >= 0 ? 'text-green-400' : 'text-red-400'}>{profit >= 0 ? '+' : ''}{formatPrice(profit)}{#if totalChange !== null} ({totalChange >= 0 ? '+' : ''}{totalChange.toFixed(1)}%){/if}</span>
				</p>
				<p class="text-xs text-[var(--color-text-muted)] mt-1">{formatPrice(stats.profitValue)} market value compared with {formatPrice(stats.profitCost)} purchase cost — {stats.profitCopies} copies with both prices.</p>
			</div>
		{/if}
		{#if missingPriceCount > 0 || missingMarketCount > 0}
			<div class="bg-yellow-900/20 border border-yellow-800 rounded-lg p-3 text-sm text-yellow-400" role="status">
				{#if missingPriceCount > 0}
					<p>{missingPriceCount} {missingPriceCount === 1 ? 'copy has' : 'copies have'} no purchase price.
						<a href="/collection" class="underline">Set missing prices</a></p>
				{/if}
				{#if missingMarketCount > 0}
					<p>{missingMarketCount} {missingMarketCount === 1 ? 'copy has' : 'copies have'} no market price and cannot be included in the collection value.</p>
				{/if}
				<p>Profit and return include only copies with both prices.</p>
			</div>
		{/if}
		{#if estimatedCount > 0}
			<p class="text-sm text-[var(--color-text-muted)]">English reference prices are used for {estimatedCount} {estimatedCount === 1 ? 'copy' : 'copies'} without a price in the card's language.</p>
		{/if}
		{#if profitHistory.length > 0}
			<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)]">
				<div class="flex items-center justify-between gap-3 mb-4 flex-wrap">
					<h2 class="text-lg font-semibold">Profit / Loss</h2>
					{@render restoreControl()}
				</div>

				{#if restoreMessage}
					<p class="text-xs text-green-400 mb-3">{restoreMessage}</p>
				{/if}

				<p class="text-xs text-[var(--color-text-muted)] mb-3">Reconstructed from your current quantities and recorded added dates, using copies with both prices available on each day. USD prices use the current exchange rate.</p>
				{#if profitHistory.some(point => point.estimated_count > 0)}
					<p class="text-xs text-[var(--color-text-muted)] mb-3">Some historical values use English reference prices where prices in the card's language are missing.</p>
				{/if}
				{#if profitHistory.some(point => point.missing_market_count > 0)}
					<p class="text-xs text-yellow-400 mb-3">Some dates have incomplete price coverage. Copies without a market price are excluded together with their purchase cost.</p>
				{/if}
				{#if chartError}<p class="text-sm text-yellow-400">{chartError}</p>{/if}

				<div style="position: relative; width: 100%; aspect-ratio: 2/1;">
					<canvas bind:this={profitChartCanvas}></canvas>
				</div>
			</div>
		{:else}
			<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)] text-center text-[var(--color-text-muted)]">
				<p>{missingPriceCount > 0 ? 'Add purchase prices to see profit and loss.' : 'No collection price history yet.'}</p>
				<p class="text-sm mt-1">Prices update automatically. Add cards with purchase prices to build this chart.</p>
				<p class="text-sm mt-3">If a re-sync changed your recorded added dates, you can restore earlier dates:</p>
				<div class="mt-3 flex flex-col items-center gap-2">
					{@render restoreControl()}
					{#if restoreMessage}
						<p class="text-xs text-green-400">{restoreMessage}</p>
					{/if}
				</div>
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
										<span class="text-[var(--color-accent)] font-medium">{formatPrice(cardValue(card))}</span>
										{#if (card.quantity as number) > 1}<p class="text-xs text-[var(--color-text-muted)]">{formatPrice(currentPrice(card))} each</p>{/if}
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
										<p class="text-xs text-[var(--color-text-muted)]">{formatPrice(cardValue(card))} total</p>
									{:else}
										{@const pct = cardProfitPct(card)}
										{#if pct != null}
											<span class="font-medium {pct >= 0 ? 'text-green-400' : 'text-red-400'}">
												{pct >= 0 ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}%
											</span>
										{/if}
										<p class="text-xs text-[var(--color-text-muted)]">{formatPrice(cardValue(card))} total</p>
									{/if}
									{#if card.estimated || (changeMode === 'daily' && card.prev_estimated)}<p class="text-xs text-[var(--color-text-muted)]">English reference</p>{/if}
								</div>
							</a>
							<button
								onclick={() => openCardChart(card.id as string, card.language as string)}
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
						Price History
					{/if}
				</h2>
				<button onclick={closeModal} aria-label="Close price history" class="text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-2xl leading-none">&times;</button>
			</div>
			{#if modalLoading}
				<p class="text-[var(--color-text-muted)] text-center py-8">Loading price data...</p>
			{:else if modalError}
				<p class="text-red-300 py-4" role="alert">{modalError}</p>
			{:else if modalEmpty}
				<p class="text-[var(--color-text-muted)] py-4">No recorded prices for this printing yet.</p>
			{:else if modalCard}
				{#if modalEstimated}<p class="text-xs text-[var(--color-text-muted)] mb-3">Includes English reference prices where prices in the card's language are missing.</p>{/if}
				<div style="position: relative; width: 100%; aspect-ratio: 2/1;">
					<canvas bind:this={modalChartCanvas}></canvas>
				</div>
			{/if}
		</div>
	</div>
{/if}
