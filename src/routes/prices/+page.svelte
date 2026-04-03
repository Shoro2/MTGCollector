<script lang="ts">
	import type { PageData } from './$types';
	import { formatPrice } from '$lib/utils';
	import CardPreview from '$lib/components/CardPreview.svelte';
	import { onMount } from 'svelte';
	import { Chart, registerables } from 'chart.js';

	let { data }: { data: PageData } = $props();

	let valueChartCanvas = $state<HTMLCanvasElement>(null!);
	let cardChartCanvas = $state<HTMLCanvasElement>(null!);
	let valueChart: Chart | null = null;
	let cardChart: Chart | null = null;
	let updating = $state(false);
	let updateMessage = $state('');

	async function triggerPriceUpdate() {
		updating = true;
		updateMessage = '';
		const res = await fetch('/api/prices', { method: 'POST' });
		const result = await res.json();
		if (result.success) {
			updateMessage = 'Price update started. This downloads ~500MB and may take a few minutes...';
			// Poll for completion
			const poll = setInterval(async () => {
				const status = await fetch('/api/prices').then((r) => r.json());
				if (!status.inProgress) {
					clearInterval(poll);
					updating = false;
					updateMessage = 'Prices updated successfully!';
					// Reload page to show new data
					window.location.reload();
				}
			}, 5000);
		} else {
			updateMessage = result.message;
			updating = false;
		}
	}

	function priceChange(card: Record<string, unknown>): { percent: number; direction: string; color: string } | null {
		const purchasePrice = card.purchase_price as number | null;
		const currentPrice = card.price as number | null;
		if (purchasePrice == null || !purchasePrice || currentPrice == null) return null;
		const percent = ((currentPrice - purchasePrice) / purchasePrice) * 100;
		if (percent > 0) return { percent, direction: '▲', color: 'text-green-400' };
		if (percent < 0) return { percent, direction: '▼', color: 'text-red-400' };
		return { percent: 0, direction: '—', color: 'text-[var(--color-text-muted)]' };
	}

	let updatedToday = $derived(
		data.priceStatus.lastUpdate
			? new Date(data.priceStatus.lastUpdate).toDateString() === new Date().toDateString()
			: false
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

	onMount(() => {
		Chart.register(...registerables);

		// Collection value chart
		if (data.valueHistory.length > 0 && valueChartCanvas) {
			valueChart = new Chart(valueChartCanvas, {
				type: 'line',
				data: {
					labels: data.valueHistory.map((h) => new Date(h.recorded_at).toLocaleDateString()),
					datasets: [
						{
							label: 'Collection Value (EUR)',
							data: data.valueHistory.map((h) => h.total_value),
							borderColor: '#f59e0b',
							backgroundColor: '#f59e0b22',
							fill: true,
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
			valueChart?.destroy();
			cardChart?.destroy();
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
				disabled={updating || data.priceStatus.inProgress || updatedToday}
				class="bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] px-4 py-1.5 rounded-lg text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
			>
				{updating || data.priceStatus.inProgress ? 'Updating...' : updatedToday ? 'Already updated today' : 'Update Prices'}
			</button>
		</div>
	</div>

	{#if updateMessage}
		<div class="bg-[var(--color-surface)] rounded-lg p-3 border border-[var(--color-border)] text-sm text-[var(--color-text-muted)]">
			{updateMessage}
		</div>
	{/if}

	<!-- Stats -->
	{@const totalChange = data.stats.totalPurchaseValue > 0 ? ((data.stats.totalValue - data.stats.totalPurchaseValue) / data.stats.totalPurchaseValue) * 100 : null}
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

	<!-- Collection Value Chart -->
	{#if data.valueHistory.length > 0}
		<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)]">
			<h2 class="text-lg font-semibold mb-4">Collection Value Over Time</h2>
			<canvas bind:this={valueChartCanvas}></canvas>
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
					<a
						href="/prices?card={card.id}"
						class="flex items-center gap-4 p-2 rounded hover:bg-[var(--color-surface-hover)] transition-colors"
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
				{/each}
			</div>
		</div>
	{/if}
</div>
