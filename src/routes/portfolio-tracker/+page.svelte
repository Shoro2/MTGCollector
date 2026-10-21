<script lang="ts">
	import type { PageData } from './$types';
	import { SITE_URL, jsonLd } from '$lib/seo';

	let { data }: { data: PageData } = $props();

	// Landing page for the product queries ("mtg portfolio tracker", "mtg card collection
	// manager") that ranked on page 3 while no page explained the portfolio features.
	// Copy rule (owner): plain sentences, no dashes, no marketing flourishes.
	const url = `${SITE_URL}/portfolio-tracker`;
	const title = 'Free MTG Portfolio Tracker: Collection Value and Profit';
	const description = 'Free tracker for your Magic: The Gathering collection: value over time, profit and loss against what you paid, Cardmarket and Moxfield import.';
	let start = $derived(data.user ? '/prices' : '/login');

	// Example data for the preview, weekly over 90 days. Never live prices.
	const value = [598, 621, 640, 688, 702, 735, 806, 829, 874, 931, 1018, 1102, 1248.3];
	const cost = [560, 560, 590, 640, 640, 675, 735, 735, 780, 820, 860, 890, 932.5];
	const line = (series: number[]) => series
		.map((v, i) => `${i ? 'L' : 'M'}${((i * 320) / (series.length - 1)).toFixed(1)},${(112 - ((v - 500) * 100) / 800).toFixed(1)}`)
		.join(' ');

	const faq = [
		['Is MTG Collector free?', 'Yes. You can browse cards and use the scanner without an account. To save a collection, a wishlist and purchase prices, sign in with Google.'],
		['Where do the prices come from?', 'From Scryfall, which publishes reference prices from Cardmarket (EUR) and TCGplayer (USD) once a day.'],
		['Can I import my Moxfield collection?', 'Yes. Upload the collection CSV from Moxfield or paste a text list. The Proxy column is respected, and you can import a whole list as proxies.'],
		['Do proxies count?', 'They count as cards, so your collection is complete, but not toward value or profit and loss.'],
		['Which currencies are supported?', 'Totals are in EUR. Cards with only a USD price are converted at the current exchange rate.']
	];
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={description} />
	<link rel="canonical" href={url} />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:type" content="website" />
	<meta property="og:url" content={url} />
	{@html `<script type="application/ld+json">${jsonLd({
		'@context': 'https://schema.org',
		'@graph': [
			{
				'@type': 'WebPage',
				'@id': url,
				url,
				name: title,
				description,
				inLanguage: 'en',
				breadcrumb: { '@id': url + '#breadcrumb' }
			},
			{
				'@type': 'BreadcrumbList',
				'@id': url + '#breadcrumb',
				itemListElement: [
					{ '@type': 'ListItem', position: 1, name: 'MTG Collector', item: SITE_URL + '/' },
					{ '@type': 'ListItem', position: 2, name: 'Portfolio tracker', item: url }
				]
			}
		]
	})}</script>`}
</svelte:head>

<article class="space-y-5">
	<nav aria-label="Breadcrumb" class="flex flex-wrap gap-2 text-sm text-[var(--color-text-muted)]">
		<a href="/" class="text-[var(--color-primary)] hover:underline">MTG Collector</a>
		<span aria-hidden="true">/</span>
		<span aria-current="page">Portfolio tracker</span>
	</nav>

	<header class="panel p-5 md:p-7">
		<p class="eyebrow">Portfolio tracker</p>
		<h1 class="mt-1 text-2xl font-semibold text-[var(--color-text-strong)] md:text-3xl">Free MTG portfolio tracker</h1>
		<p class="mt-3 max-w-2xl text-[var(--color-text-muted)]">
			See what your Magic: The Gathering collection is worth and how much you gained or lost compared with what you
			paid. Prices are updated every day.
		</p>
		<div class="mt-5 flex flex-wrap gap-2">
			<a href={start} class="btn btn-primary">Start tracking</a>
			<a href="/scan" class="btn">Scan cards</a>
		</div>
		<p class="mt-3 text-xs text-[var(--color-text-faint)]">Free to use. You sign in with your Google account.</p>
	</header>

	<section class="panel p-5" aria-labelledby="preview-heading">
		<div class="mb-4 flex flex-wrap items-center justify-between gap-2">
			<h2 id="preview-heading" class="text-sm font-semibold text-[var(--color-text)]">Example: a collection after 90 days</h2>
			<span class="chip">Example data</span>
		</div>
		<div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
			<div class="kpi-card">
				<p class="kpi-label">Collection value</p>
				<p class="kpi-value text-[var(--color-accent)]">€1,248.30</p>
				<p class="kpi-subtle">today's reference prices</p>
			</div>
			<div class="kpi-card">
				<p class="kpi-label">Invested</p>
				<p class="kpi-value">€932.50</p>
				<p class="kpi-subtle">what you paid</p>
			</div>
			<div class="kpi-card">
				<p class="kpi-label">Profit / loss</p>
				<p class="kpi-value text-green-400">+€315.80</p>
				<p class="kpi-subtle">+33.9 % on cost</p>
			</div>
			<div class="kpi-card">
				<p class="kpi-label">Cards</p>
				<p class="kpi-value">412</p>
				<p class="kpi-subtle">incl. 18 proxies, not valued</p>
			</div>
		</div>
		<figure class="mt-4">
			<svg viewBox="0 0 320 120" class="h-auto w-full" role="img"
				aria-label="Example chart: the collection value rises from €598 to €1,248 in 90 days, the purchase cost from €560 to €933">
				<path d={line(value)} class="value" />
				<path d={line(cost)} class="cost" />
			</svg>
			<figcaption class="mt-2 flex flex-wrap gap-4 text-xs text-[var(--color-text-muted)]">
				<span><span class="legend value-legend"></span>Collection value</span>
				<span><span class="legend cost-legend"></span>Purchase cost</span>
				<span>Last 90 days</span>
			</figcaption>
		</figure>
	</section>

	<div class="grid gap-4 md:grid-cols-2">
		<section class="panel p-5">
			<h2 class="text-lg font-semibold text-[var(--color-text-strong)]">Collection value over time</h2>
			<p class="mt-2 text-sm text-[var(--color-text-muted)]">
				MTG Collector stores the price of every card each day and adds up your collection with it. The chart shows how
				its value changed since you added your cards.
			</p>
			<ul class="mt-3 list-disc space-y-1 pl-5 text-sm text-[var(--color-text-muted)]">
				<li>Prices come from Scryfall's daily data: Cardmarket trend prices in EUR and TCGplayer prices in USD.</li>
				<li>EUR prices come first. Cards with only a USD price are converted at the current exchange rate.</li>
				<li>Cards in other languages use the price of that language's printing where one exists.</li>
				<li>Every card you own has its own price history chart.</li>
			</ul>
		</section>

		<section class="panel p-5">
			<h2 class="text-lg font-semibold text-[var(--color-text-strong)]">Profit and loss against what you paid</h2>
			<p class="mt-2 text-sm text-[var(--color-text-muted)]">
				Enter the price you paid for each copy, or import it. MTG Collector compares it with today's value for every card
				and for the whole collection.
			</p>
			<ul class="mt-3 list-disc space-y-1 pl-5 text-sm text-[var(--color-text-muted)]">
				<li>Import purchase prices from a Cardmarket order export (CSV) or from Cardtrader (XLS).</li>
				<li>Missing purchase prices can be filled with today's value in one step.</li>
				<li>A chart shows profit and loss over time, and a list shows your most valuable cards.</li>
				<li>Copies without a price are listed separately and never counted as a loss.</li>
			</ul>
		</section>

		<section class="panel p-5">
			<h2 class="text-lg font-semibold text-[var(--color-text-strong)]">Adding cards</h2>
			<ul class="mt-3 list-disc space-y-1 pl-5 text-sm text-[var(--color-text-muted)]">
				<li>
					<a href="/scan" class="text-[var(--color-primary)] hover:underline">Scan cards</a> with your phone camera or from a
					photo, several at once, in English or German. Text recognition runs in your browser.
				</li>
				<li>Import CSV files from Moxfield, ManaBox, Dragon Shield or Delver Lens, or paste a Moxfield text list. You see every row before anything is saved.</li>
				<li>Export to Moxfield as CSV or text, or as a full backup with locations, notes, tags and purchase prices.</li>
			</ul>
		</section>

		<section class="panel p-5">
			<h2 class="text-lg font-semibold text-[var(--color-text-strong)]">Organizing your collection</h2>
			<ul class="mt-3 list-disc space-y-1 pl-5 text-sm text-[var(--color-text-muted)]">
				<li>Locations for boxes, binders and decks, and your own tags.</li>
				<li>Condition, language and finish for every copy.</li>
				<li>Proxies count as cards but not toward value or profit.</li>
				<li>A wishlist with priorities. When you get a card, it moves into your collection.</li>
				<li><a href="/cards" class="text-[var(--color-primary)] hover:underline">The card database</a> lists every printing with rules, legality and prices.</li>
			</ul>
		</section>
	</div>

	<section class="panel p-5">
		<h2 class="text-lg font-semibold text-[var(--color-text-strong)]">Where the numbers come from</h2>
		<p class="mt-2 text-sm text-[var(--color-text-muted)]">
			All prices are reference prices from Cardmarket and TCGplayer, not offers to buy or sell. If the EUR and USD prices
			of a card contradict each other, the card page asks you to check the price. MTG Collector is in open beta.
		</p>
	</section>

	<section class="panel p-5" aria-labelledby="faq-heading">
		<h2 id="faq-heading" class="text-lg font-semibold text-[var(--color-text-strong)]">Questions</h2>
		<div class="mt-3 space-y-4">
			{#each faq as [question, answer]}
				<div>
					<h3 class="text-sm font-semibold text-[var(--color-text)]">{question}</h3>
					<p class="mt-1 text-sm text-[var(--color-text-muted)]">{answer}</p>
				</div>
			{/each}
		</div>
	</section>

	<section class="panel flex flex-wrap items-center justify-between gap-3 p-5">
		<p class="font-semibold text-[var(--color-text-strong)]">Start tracking your collection for free.</p>
		<div class="flex flex-wrap gap-2">
			<a href={start} class="btn btn-primary">Start tracking</a>
			<a href="/scan" class="btn">Scan cards</a>
		</div>
	</section>
</article>

<style>
	svg path {
		fill: none;
		stroke-width: 2.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.value {
		stroke: var(--color-accent);
	}
	.cost {
		stroke: var(--color-text-muted);
		stroke-dasharray: 5 4;
	}
	.legend {
		display: inline-block;
		width: 0.9rem;
		margin-right: 0.35rem;
		vertical-align: middle;
		border-top: 2px solid;
	}
	.value-legend {
		border-color: var(--color-accent);
	}
	.cost-legend {
		border-top-style: dashed;
		border-color: var(--color-text-muted);
	}
</style>
