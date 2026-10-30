<script lang="ts">
	import type { PageData } from './$types';
	import { euro } from '$lib/home';
	import { SITE_URL, jsonLd } from '$lib/seo';

	let { data }: { data: PageData } = $props();

	// Visitor-facing copy: no dashes, no marketing phrases (owner's rule).
	const title = 'MTG Collector: Free Card Scanner and Collection Tracker';
	const description = "Scan Magic: The Gathering cards, look up prices for every printing and follow your collection's value and profit. Free to use, with Moxfield import.";

	const change = (pct: number) => `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%`;
	const signed = (amount: number) => `${amount >= 0 ? '+' : '−'}${euro(Math.abs(amount))}`;
	const unitPrice = (eur: number | null, usd: number | null) =>
		eur != null ? euro(eur) : usd != null ? `$${usd.toFixed(2)}` : 'no price';
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={description} />
	<link rel="canonical" href="https://mtg-collector.com/" />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:type" content="website" />
	<meta property="og:url" content="https://mtg-collector.com/" />
	{@html `<script type="application/ld+json">${jsonLd({
		'@context': 'https://schema.org',
		'@type': 'WebSite',
		name: 'MTG Collector',
		url: SITE_URL + '/',
		description: 'A Magic: The Gathering card scanner, collection tracker and price database.',
		inLanguage: 'en'
	})}</script>`}
</svelte:head>

{#if data.visitor}
	{@const visitor = data.visitor}
	<div class="space-y-8">
		<section class="mx-auto flex max-w-3xl flex-col items-center gap-3.5 pt-3 text-center md:pt-8">
			<p class="eyebrow text-[var(--color-accent)]">Free for Magic: The Gathering players</p>
			<h1 class="text-[28px] font-semibold leading-tight text-[var(--color-text-strong)] md:text-[40px]">
				Scan, look up and track your Magic cards
			</h1>
			<p class="max-w-xl text-base text-[var(--color-text-muted)]">MTG Collector is free to use. Pick where you want to start.</p>
			<a href="/login" class="btn btn-primary min-h-[44px] px-5 text-sm">Start your collection</a>
			<p class="text-xs text-[var(--color-text-muted)]">You sign in with your Google account.</p>
		</section>

		<section aria-label="Where to start" class="grid gap-4 md:grid-cols-3">
			<a href="/portfolio-tracker" class="entry panel flex flex-col gap-3 p-[18px] no-underline">
				<div class="entry-visual flex flex-col gap-2 p-3" aria-hidden="true">
					<span class="kpi-label">Collection value</span>
					<svg viewBox="0 0 320 120" class="block h-[90px] w-full" preserveAspectRatio="none">
						<path d="M0,104.5 L26.7,104.5 L53.3,100.8 L80,94.5 L106.7,94.5 L133.3,90.1 L160,82.6 L186.7,82.6 L213.3,77 L240,72 L266.7,67 L293.3,63.3 L320,57.9" fill="none" stroke="var(--color-text-muted)" stroke-width="2" stroke-dasharray="5 4" vector-effect="non-scaling-stroke"></path>
						<path d="M0,99.8 L26.7,96.9 L53.3,94.5 L80,88.5 L106.7,86.8 L133.3,82.6 L160,73.8 L186.7,70.9 L213.3,65.3 L240,58.1 L266.7,47.3 L293.3,36.8 L320,18.5" fill="none" stroke="var(--color-accent)" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"></path>
					</svg>
				</div>
				<h2 class="text-lg font-semibold text-[var(--color-text-strong)]">Track value</h2>
				<p class="text-sm text-[var(--color-text-muted)]">The value of your collection over time and your profit or loss against what you paid.</p>
				<span class="mt-auto text-sm font-semibold text-[var(--color-primary)]">Portfolio tracker</span>
			</a>

			<a href="/cards" class="entry panel flex flex-col gap-3 p-[18px] no-underline">
				<div class="entry-visual flex flex-col gap-1.5 p-3" aria-hidden="true">
					<span class="flex min-h-8 items-center rounded-md border border-[var(--color-border-strong)] px-2.5 text-xs text-[var(--color-text-muted)]">Lightning Bolt</span>
					{#each visitor.sample as printing}
						<span class="flex min-h-[22px] items-center justify-between gap-2 text-xs">
							<span class="truncate text-[var(--color-text)]">{printing.set_name}</span>
							<span class="price text-[var(--color-accent)]">{euro(printing.price)}</span>
						</span>
					{/each}
				</div>
				<h2 class="text-lg font-semibold text-[var(--color-text-strong)]">Find card prices</h2>
				<p class="text-sm text-[var(--color-text-muted)]">
					{data.cardCount ? `${data.cardCount.toLocaleString('en-US')} cards` : 'Every card'} in every printing, with daily prices, rules text and format legality.
				</p>
				<span class="mt-auto text-sm font-semibold text-[var(--color-primary)]">Card database</span>
			</a>

			<a href="/scan" class="entry panel flex flex-col gap-3 p-[18px] no-underline">
				<div class="entry-visual entry-visual-dark flex items-center justify-center gap-3.5" aria-hidden="true">
					<span class="h-[89px] w-16 rounded-md border-2 border-[var(--color-accent)] bg-[rgba(245,166,35,0.06)]"></span>
					<span class="flex flex-col gap-1.5">
						<span class="scan-chip scan-chip-ok">Lightning Bolt</span>
						<span class="scan-chip scan-chip-ok">Kriegshorn</span>
						<span class="scan-chip scan-chip-open">Sol Ring: printing?</span>
					</span>
				</div>
				<h2 class="text-lg font-semibold text-[var(--color-text-strong)]">Scan cards</h2>
				<p class="text-sm text-[var(--color-text-muted)]">Camera or photo, several cards at once, also German cards. Works without an account.</p>
				<span class="mt-auto text-sm font-semibold text-[var(--color-primary)]">Open the scanner</span>
			</a>
		</section>

		{#if visitor.movesHeading && (visitor.up.length || visitor.down.length)}
			<section aria-labelledby="price-moves" class="panel flex flex-col gap-3 p-5">
				<div class="flex flex-wrap items-baseline justify-between gap-2">
					<h2 id="price-moves" class="text-lg font-semibold text-[var(--color-text-strong)]">{visitor.movesHeading}</h2>
					<a href="/cards" class="text-sm font-semibold text-[var(--color-primary)] no-underline hover:underline">Browse the card database</a>
				</div>
				<div class="grid gap-x-6 gap-y-4 md:grid-cols-2">
					{#each [{ label: 'Rising', rows: visitor.up }, { label: 'Falling', rows: visitor.down }] as column}
						{#if column.rows.length}
							<div class="min-w-0">
								<p class="eyebrow mb-1">{column.label}</p>
								<ul>
									{#each column.rows as move}
										<li>
											<svelte:element this={move.href ? 'a' : 'div'} href={move.href} class="move-row">
												<span class="min-w-0 flex-1 truncate">{move.name}</span>
												<span class="chip set-code">{move.setCode}</span>
												<span class="price w-[76px] text-right">{euro(move.price)}</span>
												<span class="price w-[68px] text-right {move.pct > 0 ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}">{change(move.pct)}</span>
											</svelte:element>
										</li>
									{/each}
								</ul>
							</div>
						{/if}
					{/each}
				</div>
				<p class="text-xs text-[var(--color-text-muted)]">
					Cardmarket trend prices of printings from €2, each against its previous price. Prices far from the TCGplayer price are left out.
				</p>
			</section>
		{/if}
	</div>
{:else if data.dashboard}
	{@const dash = data.dashboard}
	{@const s = dash.summary}
	<div class="space-y-5">
		<div class="page-heading">
			<div>
				<h1 class="text-[22px] font-semibold text-[var(--color-text-strong)] md:text-[26px]">
					Welcome back{data.user?.name ? `, ${data.user.name}` : ''}
				</h1>
				<p class="mt-1 text-sm text-[var(--color-text-muted)]">Your collection with today's prices.</p>
			</div>
			<div class="flex flex-wrap gap-2">
				<a href="/scan" class="btn btn-primary min-h-[44px] px-4">Scan cards</a>
				<a href="/collection?import=1" class="btn min-h-[44px] px-4">Import</a>
			</div>
		</div>

		<div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
			<div class="kpi-card">
				<p class="kpi-label">Collection value</p>
				<p class="kpi-value text-[var(--color-accent)]">{euro(s.value)}</p>
				{#if s.change != null}
					<p class="kpi-subtle {s.change > 0 ? 'text-[var(--color-success)]' : s.change < 0 ? 'text-[var(--color-danger)]' : ''}">
						{s.change === 0 ? 'No change today' : `${s.change > 0 ? '▲' : '▼'} ${euro(Math.abs(s.change))} today`}
					</p>
				{/if}
			</div>
			<div class="kpi-card">
				<p class="kpi-label">Profit / loss</p>
				{#if s.profit != null}
					<p class="kpi-value {s.profit >= 0 ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}">{signed(s.profit)}</p>
					{#if s.profitPct != null}
						<p class="kpi-subtle">{s.profitPct >= 0 ? '+' : '−'}{Math.abs(s.profitPct).toFixed(1)}% on what you paid</p>
					{/if}
				{:else}
					<p class="kpi-value text-base text-[var(--color-text-muted)]">No purchase prices yet</p>
				{/if}
			</div>
			<div class="kpi-card">
				<p class="kpi-label">Cards</p>
				<p class="kpi-value">{s.cards.toLocaleString('en-US')}</p>
				<p class="kpi-subtle">
					{s.proxies ? `${s.proxies} of them ${s.proxies === 1 ? 'a proxy' : 'proxies'}` : `${s.printings.toLocaleString('en-US')} ${s.printings === 1 ? 'printing' : 'printings'}`}
				</p>
			</div>
			<a href="/wishlist" class="kpi-card no-underline transition-colors hover:border-[var(--color-border-strong)]">
				<p class="kpi-label">Wishlist</p>
				<p class="kpi-value">{dash.wishlist.toLocaleString('en-US')}</p>
				<p class="kpi-subtle">{dash.wishlist === 1 ? 'card you want' : 'cards you want'}</p>
			</a>
		</div>

		{#if s.cards === 0}
			<section class="panel flex flex-col items-start gap-3 p-6">
				<h2 class="text-lg font-semibold text-[var(--color-text-strong)]">Your collection is empty</h2>
				<p class="text-sm text-[var(--color-text-muted)]">Scan your cards or import a list from Moxfield. What you add shows up here with its prices.</p>
				<div class="flex flex-wrap gap-2">
					<a href="/scan" class="btn btn-primary">Scan cards</a>
					<a href="/collection?import=1" class="btn">Import a list</a>
				</div>
			</section>
		{:else}
			<section aria-labelledby="value-chart" class="panel flex flex-col gap-3 p-5">
				<div class="flex flex-wrap items-baseline justify-between gap-2">
					<h2 id="value-chart" class="text-base font-semibold text-[var(--color-text-strong)]">Value and purchase cost, last 90 days</h2>
					<a href="/prices" class="text-sm font-semibold text-[var(--color-primary)] no-underline hover:underline">Price details</a>
				</div>
				{#if dash.chart}
					<svg
						viewBox="0 0 320 120"
						role="img"
						aria-label="Value from {euro(dash.chart.first.value)} to {euro(dash.chart.last.value)}, purchase cost from {euro(dash.chart.first.cost)} to {euro(dash.chart.last.cost)}"
						class="block h-[160px] w-full md:h-[220px]"
						preserveAspectRatio="none"
					>
						<path d={dash.chart.cost} fill="none" stroke="var(--color-text-muted)" stroke-width="2" stroke-dasharray="5 4" vector-effect="non-scaling-stroke"></path>
						<path d={dash.chart.value} fill="none" stroke="var(--color-accent)" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"></path>
					</svg>
					<div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-text-muted)]">
						<span class="flex items-center gap-1.5"><span class="w-3.5 border-t-2 border-[var(--color-accent)]"></span>Value</span>
						<span class="flex items-center gap-1.5"><span class="w-3.5 border-t-2 border-dashed border-[var(--color-text-muted)]"></span>Purchase cost</span>
						<span>Counts the {dash.profitCopies.toLocaleString('en-US')} {dash.profitCopies === 1 ? 'copy' : 'copies'} with a purchase price.</span>
					</div>
				{:else if dash.profitCopies === 0}
					<p class="text-sm text-[var(--color-text-muted)]">
						Add purchase prices to your cards to see their value against what you paid.
						<a href="/collection" class="font-semibold text-[var(--color-primary)] no-underline hover:underline">Open collection</a>
					</p>
				{:else}
					<p class="text-sm text-[var(--color-text-muted)]">The chart fills in with the next price updates.</p>
				{/if}
			</section>

			<div class="grid items-start gap-5 lg:grid-cols-2">
				<section aria-labelledby="collection-moves" class="panel flex min-w-0 flex-col gap-2 p-5">
					<h2 id="collection-moves" class="text-base font-semibold text-[var(--color-text-strong)]">Biggest moves in your collection</h2>
					{#if dash.up.length || dash.down.length}
						<ul>
							{#each [...dash.up, ...dash.down] as move}
								<li>
									<a href="/cards/{move.id}" class="move-row">
										<span class="min-w-0 flex-1 truncate">{move.name}</span>
										{#if move.foil}<span class="chip text-[11px]">Foil</span>{/if}
										<span class="chip set-code">{move.setCode}</span>
										<span class="price w-[76px] text-right">{euro(move.price)}</span>
										<span class="price w-[68px] text-right {move.pct > 0 ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}">{change(move.pct)}</span>
									</a>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="text-sm text-[var(--color-text-muted)]">No price changes in your collection today.</p>
					{/if}
					<p class="text-xs text-[var(--color-text-muted)]">Today against the price before. Cards under €1 and proxies are not included.</p>
				</section>

				<section aria-labelledby="recently-added" class="panel flex min-w-0 flex-col gap-2 p-5">
					<div class="flex flex-wrap items-baseline justify-between gap-2">
						<h2 id="recently-added" class="text-base font-semibold text-[var(--color-text-strong)]">Recently added</h2>
						<a href="/collection" class="text-sm font-semibold text-[var(--color-primary)] no-underline hover:underline">Open collection</a>
					</div>
					<ul>
						{#each dash.recent as entry}
							<li>
								<a href="/cards/{entry.card_id}" class="move-row">
									<span class="min-w-0 flex-1 truncate">
										{entry.name}{#if entry.quantity > 1}<span class="ml-1 text-[var(--color-text-muted)]">×{entry.quantity}</span>{/if}
									</span>
									<span class="max-w-[40%] truncate text-xs text-[var(--color-text-muted)]">{[entry.proxy ? 'Proxy' : '', entry.location].filter(Boolean).join(', ')}</span>
									<span class="price w-[84px] shrink-0 text-right {entry.proxy ? 'text-xs text-[var(--color-text-muted)]' : ''}">
										{entry.proxy ? 'not valued' : unitPrice(entry.price, entry.price_usd)}
									</span>
								</a>
							</li>
						{/each}
					</ul>
				</section>
			</div>
		{/if}
	</div>
{/if}

{#if data.catalogueEmpty}
	<div class="panel mt-5 p-6 text-center">
		<h2 class="text-lg font-semibold">Getting Started</h2>
		<p class="mt-2 text-sm text-[var(--color-text-muted)]">
			Import the MTG card database from Scryfall to get started.
		</p>
		<p class="mt-4 text-xs text-[var(--color-text-muted)]">
			Run <code class="rounded bg-[var(--color-bg)] px-2 py-1 font-mono">npm run import-cards</code> in your terminal.
		</p>
	</div>
{/if}

<style>
	.entry {
		color: var(--color-text);
		transition: border-color 0.15s, background-color 0.15s;
	}
	.entry:hover {
		border-color: rgba(111, 178, 255, 0.38);
		background: var(--color-surface-hover);
	}
	.entry-visual {
		height: 150px;
		border: 1px solid var(--color-border);
		border-radius: 10px;
		background: #0d131c;
	}
	.entry-visual-dark {
		background: #05080c;
	}
	.scan-chip {
		border: 1px solid;
		border-radius: 6px;
		padding: 2px 8px;
		font-size: 11px;
		font-weight: 600;
	}
	.scan-chip-ok {
		color: var(--color-success);
		border-color: rgba(70, 197, 120, 0.4);
	}
	.scan-chip-open {
		color: var(--color-accent);
		border-color: rgba(245, 166, 35, 0.4);
	}
	:global(.move-row) {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		min-height: 40px;
		border-bottom: 1px solid var(--color-border-subtle);
		color: var(--color-text);
		font-size: 0.875rem;
		text-decoration: none;
	}
	:global(a.move-row:hover) {
		background: rgba(255, 255, 255, 0.03);
	}
</style>
