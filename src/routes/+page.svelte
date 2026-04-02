<script lang="ts">
	import type { PageData } from './$types';
	import { formatPrice } from '$lib/utils';

	let { data }: { data: PageData } = $props();
</script>

<div class="space-y-8">
	<div>
		<h1 class="text-3xl font-bold mb-2">MTG Collector</h1>
		<p class="text-[var(--color-text-muted)]">Track your Magic: The Gathering collection</p>
	</div>

	<div class="grid grid-cols-1 md:grid-cols-3 gap-6">
		<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)]">
			<h3 class="text-[var(--color-text-muted)] text-sm uppercase tracking-wide mb-1">Cards in Database</h3>
			<p class="text-3xl font-bold">{data.totalCards.toLocaleString()}</p>
		</div>
		<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)]">
			<h3 class="text-[var(--color-text-muted)] text-sm uppercase tracking-wide mb-1">Cards in Collection</h3>
			<p class="text-3xl font-bold">{data.collectionCount.toLocaleString()}</p>
		</div>
		<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)]">
			<h3 class="text-[var(--color-text-muted)] text-sm uppercase tracking-wide mb-1">Collection Value</h3>
			<p class="text-3xl font-bold text-[var(--color-accent)]">{formatPrice(data.collectionValue)}</p>
		</div>
	</div>

	{#if data.totalCards === 0}
		<div class="bg-[var(--color-surface)] rounded-lg p-8 border border-[var(--color-border)] text-center">
			<h2 class="text-xl font-semibold mb-2">Getting Started</h2>
			<p class="text-[var(--color-text-muted)] mb-4">
				Import the MTG card database from Scryfall to get started.
			</p>
			<p class="text-[var(--color-text-muted)] text-sm">
				Run <code class="bg-[var(--color-bg)] px-2 py-1 rounded">npm run import-cards</code> in your terminal.
			</p>
		</div>
	{:else}
		<div class="flex gap-4">
			<a
				href="/cards"
				class="bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] px-6 py-3 rounded-lg font-medium transition-colors"
			>
				Browse Cards
			</a>
			<a
				href="/collection"
				class="bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] px-6 py-3 rounded-lg font-medium border border-[var(--color-border)] transition-colors"
			>
				My Collection
			</a>
		</div>
	{/if}
</div>
