<script lang="ts">
	import type { PageData } from './$types';
	import { formatPrice } from '$lib/utils';
	import type { LayoutData } from './$types';

	let { data }: { data: PageData & LayoutData } = $props();

	let noticeOpen = $state(true);

	const quickActions = $derived([
		{
			href: '/scan',
			title: 'Scan cards',
			description: 'Batch-detect a full spread',
			tone: 'tone-info',
			icon: 'scan'
		},
		{
			href: '/cards',
			title: 'Browse database',
			description: `${data.totalCards.toLocaleString()} searchable cards`,
			tone: 'tone-success',
			icon: 'search'
		},
		{
			href: data.user ? '/collection' : '/login',
			title: data.user ? 'Open collection' : 'Start collection',
			description: data.user ? 'Manage positions and tags' : 'Sign in with Google',
			tone: 'tone-accent',
			icon: 'collection'
		},
		{
			href: data.user ? '/prices' : '/login',
			title: 'Track prices',
			description: 'Value, profit and history',
			tone: 'tone-violet',
			icon: 'chart'
		}
	]);
</script>

<svelte:head>
	<title>MTG Collector - Scan Entire Boosters & Track Your MTG Collection</title>
	<meta name="description" content="Track your Magic: The Gathering collection and scan entire boosters at once. Browse over {data.totalCards.toLocaleString()} MTG cards, monitor prices, and manage your collection with our batch card scanner." />
	<link rel="canonical" href="https://mtg-collector.com/" />
	<meta property="og:title" content="MTG Collector - Magic: The Gathering Collection Tracker & Price Database" />
	<meta property="og:description" content="Track your Magic: The Gathering collection, monitor card prices, and browse over {data.totalCards.toLocaleString()} MTG cards. Free online MTG collection manager with price history and card scanner." />
	<meta property="og:url" content="https://mtg-collector.com/" />
</svelte:head>

<div class="space-y-5">
	{#if noticeOpen}
		<div class="notice-beta flex items-center gap-3 rounded-lg border px-3.5 py-3 text-sm">
			<span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[rgba(245,166,35,0.16)] text-[var(--color-accent)]">
				<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="10"></circle>
					<path d="M12 8v4"></path>
					<path d="M12 16h.01"></path>
				</svg>
			</span>
			<p class="flex-1">
				MTG Collector is in <strong class="notice-beta-strong font-semibold">open beta</strong>. Core collection, scanner and price workflows are available while the interface keeps improving.
			</p>
			<button
				type="button"
				onclick={() => (noticeOpen = false)}
				aria-label="Dismiss notice"
				class="notice-beta-button flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors"
			>
				<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
					<path d="M18 6 6 18"></path>
					<path d="m6 6 12 12"></path>
				</svg>
			</button>
		</div>
	{/if}

	<div class="page-heading">
		<div>
			<p class="eyebrow">Portfolio workspace</p>
			<h1 class="mt-1 text-[22px] font-semibold text-[var(--color-text-strong)] md:text-2xl">
				{data.user ? `Welcome back, ${data.user.name}` : 'MTG Collector'}
			</h1>
			<p class="mt-1 text-sm text-[var(--color-text-muted)]">
				A dense collection tracker for cards, prices, scans and wishlist decisions.
			</p>
		</div>
		<a href="/scan" class="btn btn-primary">
			<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
				<path d="M3 7V5a2 2 0 0 1 2-2h2"></path>
				<path d="M17 3h2a2 2 0 0 1 2 2v2"></path>
				<path d="M21 17v2a2 2 0 0 1-2 2h-2"></path>
				<path d="M7 21H5a2 2 0 0 1-2-2v-2"></path>
				<path d="M7 12h10"></path>
			</svg>
			Scan cards
		</a>
	</div>

	<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
		<div class="kpi-card">
			<p class="kpi-label">Cards in Database</p>
			<p class="kpi-value">{data.totalCards.toLocaleString()}</p>
			<p class="kpi-subtle">Scryfall-backed catalog</p>
		</div>
		<div class="kpi-card">
			<p class="kpi-label">Cards in Collection</p>
			<p class="kpi-value">{data.collectionCount.toLocaleString()}</p>
			<p class="kpi-subtle">{data.user ? 'across your printings' : 'sign in to track yours'}</p>
		</div>
		<div class="kpi-card">
			<p class="kpi-label">Collection Value</p>
			<p class="kpi-value text-[var(--color-accent)]">{formatPrice(data.collectionValue)}</p>
			<p class="kpi-subtle">EUR first, USD fallback</p>
		</div>
		<div class="kpi-card">
			<p class="kpi-label">Scanner</p>
			<p class="kpi-value">OCR</p>
			<p class="kpi-subtle">local first, Vision optional</p>
		</div>
	</div>

	<div class="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
		<section class="panel p-5">
			<div class="mb-4 flex items-center justify-between gap-3">
				<div>
					<h2 class="text-sm font-semibold text-[var(--color-text)]">Collection flow</h2>
					<p class="mt-1 text-xs text-[var(--color-text-faint)]">Browse, scan, import, price and decide what to collect next.</p>
				</div>
				<span class="chip set-code">LIVE DATA</span>
			</div>
			<div class="grid gap-3 md:grid-cols-3">
				<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4">
					<p class="eyebrow">1. Find</p>
					<p class="mt-2 text-sm font-semibold">Search every set</p>
					<p class="mt-1 text-xs text-[var(--color-text-muted)]">Filter by color, rarity, type, legality and prices.</p>
				</div>
				<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4">
					<p class="eyebrow">2. Add</p>
					<p class="mt-2 text-sm font-semibold">Scan or import</p>
					<p class="mt-1 text-xs text-[var(--color-text-muted)]">OCR spreads, Moxfield CSV, tags, condition and purchase price.</p>
				</div>
				<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4">
					<p class="eyebrow">3. Track</p>
					<p class="mt-2 text-sm font-semibold">Watch value move</p>
					<p class="mt-1 text-xs text-[var(--color-text-muted)]">Daily snapshots, profit/loss and top-card history.</p>
				</div>
			</div>
		</section>

		<aside class="space-y-2">
			<p class="eyebrow px-1">Quick actions</p>
			{#each quickActions as action}
				<a href={action.href} class="panel flex items-center gap-3 p-3 no-underline transition-colors hover:border-[rgba(111,178,255,0.38)] hover:bg-[var(--color-surface-hover)]">
					<span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg {action.tone}">
						{#if action.icon === 'scan'}
							<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
								<path d="M3 7V5a2 2 0 0 1 2-2h2"></path>
								<path d="M17 3h2a2 2 0 0 1 2 2v2"></path>
								<path d="M21 17v2a2 2 0 0 1-2 2h-2"></path>
								<path d="M7 21H5a2 2 0 0 1-2-2v-2"></path>
								<path d="M7 12h10"></path>
							</svg>
						{:else if action.icon === 'search'}
							<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
								<circle cx="11" cy="11" r="8"></circle>
								<path d="m21 21-4.3-4.3"></path>
							</svg>
						{:else if action.icon === 'collection'}
							<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
								<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
								<path d="m17 8-5-5-5 5"></path>
								<path d="M12 3v12"></path>
							</svg>
						{:else}
							<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
								<path d="m23 6-9.5 9.5-5-5L1 18"></path>
								<path d="M17 6h6v6"></path>
							</svg>
						{/if}
					</span>
					<span>
						<span class="block text-sm font-semibold text-[var(--color-text)]">{action.title}</span>
						<span class="block text-xs text-[var(--color-text-muted)]">{action.description}</span>
					</span>
				</a>
			{/each}
		</aside>
	</div>

	{#if data.totalCards === 0}
		<div class="panel p-6 text-center">
			<h2 class="text-lg font-semibold">Getting Started</h2>
			<p class="mt-2 text-sm text-[var(--color-text-muted)]">
				Import the MTG card database from Scryfall to get started.
			</p>
			<p class="mt-4 text-xs text-[var(--color-text-muted)]">
				Run <code class="rounded bg-[var(--color-bg)] px-2 py-1 font-mono">npm run import-cards</code> in your terminal.
			</p>
		</div>
	{/if}
</div>
