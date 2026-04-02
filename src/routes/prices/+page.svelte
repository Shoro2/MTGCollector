<script lang="ts">
	import type { PageData } from './$types';
	import { formatPrice } from '$lib/utils';
	import { onMount } from 'svelte';
	import { Chart, registerables } from 'chart.js';

	let { data }: { data: PageData } = $props();

	let valueChartCanvas = $state<HTMLCanvasElement>(null!);
	let cardChartCanvas = $state<HTMLCanvasElement>(null!);
	let valueChart: Chart | null = null;
	let cardChart: Chart | null = null;

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
	<h1 class="text-2xl font-bold">Price Tracking</h1>

	<!-- Stats -->
	<div class="grid grid-cols-3 gap-4">
		<div class="bg-[var(--color-surface)] rounded-lg p-4 border border-[var(--color-border)]">
			<p class="text-sm text-[var(--color-text-muted)]">Collection Value</p>
			<p class="text-2xl font-bold text-[var(--color-accent)]">{formatPrice(data.stats.totalValue)}</p>
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
			<p>No price history yet. Price data is recorded when you import cards.</p>
			<p class="text-sm mt-1">Run <code class="bg-[var(--color-bg)] px-2 py-0.5 rounded">npm run import-cards</code> periodically to update prices.</p>
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
							<img
								src={(card.local_image_path || card.image_uri) as string}
								alt={card.name as string}
								class="w-10 h-14 object-cover rounded"
								loading="lazy"
							/>
						{/if}
						<div class="flex-1 min-w-0">
							<p class="font-medium truncate">{card.name}</p>
							<p class="text-xs text-[var(--color-text-muted)]">
								{card.set_name} &middot; {card.quantity}x {#if card.foil}<span class="text-[var(--color-accent)]">FOIL</span>{/if}
							</p>
						</div>
						<span class="text-[var(--color-accent)] font-medium">{formatPrice(card.price as number)}</span>
					</a>
				{/each}
			</div>
		</div>
	{/if}
</div>
