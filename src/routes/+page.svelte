<script lang="ts">
	import type { PageData } from './$types';
	import { formatPrice } from '$lib/utils';
	import type { LayoutData } from './$types';

	let { data }: { data: PageData & LayoutData } = $props();
</script>

<svelte:head>
	<title>MTG Collector - Scan Entire Boosters & Track Your MTG Collection</title>
	<meta name="description" content="Track your Magic: The Gathering collection and scan entire boosters at once. Browse over {data.totalCards.toLocaleString()} MTG cards, monitor prices, and manage your collection with our batch card scanner." />
	<link rel="canonical" href="https://mtg-collector.com/" />
	<meta property="og:title" content="MTG Collector - Magic: The Gathering Collection Tracker & Price Database" />
	<meta property="og:description" content="Track your Magic: The Gathering collection, monitor card prices, and browse over {data.totalCards.toLocaleString()} MTG cards. Free online MTG collection manager with price history and card scanner." />
	<meta property="og:url" content="https://mtg-collector.com/" />
</svelte:head>

<div class="space-y-8">
	<div class="bg-yellow-900/30 border border-yellow-600/50 rounded-lg p-4 text-yellow-200 text-sm">
		This site is currently under construction and in testing. Features may be incomplete or change without notice.
	</div>

	<div>
		<h1 class="text-3xl font-bold mb-2">MTG Collector</h1>
		<p class="text-[var(--color-text-muted)]">Track your Magic: The Gathering collection</p>
	</div>

	<div class="grid grid-cols-1 md:grid-cols-3 gap-6">
		<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)]">
			<h3 class="text-[var(--color-text-muted)] text-sm uppercase tracking-wide mb-1">Cards in Database</h3>
			<p class="text-3xl font-bold">{data.totalCards.toLocaleString()}</p>
		</div>
		{#if data.user}
			<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)]">
				<h3 class="text-[var(--color-text-muted)] text-sm uppercase tracking-wide mb-1">Cards in Collection</h3>
				<p class="text-3xl font-bold">{data.collectionCount.toLocaleString()}</p>
			</div>
			<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)]">
				<h3 class="text-[var(--color-text-muted)] text-sm uppercase tracking-wide mb-1">Collection Value</h3>
				<p class="text-3xl font-bold text-[var(--color-accent)]">{formatPrice(data.collectionValue)}</p>
			</div>
		{/if}
	</div>

	<section class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)]">
		<h2 class="text-xl font-semibold mb-3">Your Magic: The Gathering Collection Manager</h2>
		<p class="text-[var(--color-text-muted)] leading-relaxed">
			Browse over {data.totalCards.toLocaleString()} Magic: The Gathering cards from every set and edition.
			Scan an entire booster pack or a full spread of cards in a single photo — our batch card scanner
			automatically detects every card, reads names and collector numbers via OCR, identifies foils,
			and looks up current prices. Track your collection with daily price history and monitor your portfolio value.
		</p>
	</section>

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
				class="bg-[var(--color-primary-button)] hover:bg-[var(--color-primary-button-hover)] px-6 py-3 rounded-lg font-medium transition-colors"
			>
				Browse Cards
			</a>
			{#if data.user}
				<a
					href="/collection"
					class="bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] px-6 py-3 rounded-lg font-medium border border-[var(--color-border)] transition-colors"
				>
					My Collection
				</a>
			{:else}
				<a
					href="/login"
					class="bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] px-6 py-3 rounded-lg font-medium border border-[var(--color-border)] transition-colors"
				>
					Sign in to start collecting
				</a>
			{/if}
		</div>
	{/if}
</div>
