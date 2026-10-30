<script lang="ts">
	import type { PageData } from './$types';
	import { SITE_URL, cardPageUrl, jsonLd } from '$lib/seo';
	import { getRarityColor } from '$lib/utils';
	import { formatQuote, parseCurrency } from '$lib/currency';
	import { cardPageMeta, cheapestPrice } from '$lib/card-page';
	import ManaCost from '$lib/components/ManaCost.svelte';
	import ColorPips from '$lib/components/ColorPips.svelte';
	import FormatLegality from '$lib/components/FormatLegality.svelte';

	let { data }: { data: PageData } = $props();

	const LANGUAGES: Record<string, string> = {
		de: 'German', fr: 'French', it: 'Italian', es: 'Spanish', pt: 'Portuguese', ja: 'Japanese',
		ko: 'Korean', ru: 'Russian', zhs: 'Chinese (Simplified)', zht: 'Chinese (Traditional)'
	};

	let card = $derived(data.card);
	let name = $derived(card.name as string);
	let canonical = $derived(cardPageUrl(data.slug));
	// Double-faced cards keep their rules text on the faces.
	let meta = $derived(cardPageMeta({
		name,
		type_line: card.type_line as string | null,
		oracle_text: (card.oracle_text || data.faces[0]?.oracle_text || null) as string | null,
		set_name: card.set_name as string | null
	}, data.printings));
	// The viewer's display currency (/settings); the search snippet above stays in euros.
	const currency = $derived(parseCurrency(data.currency));
	let cheapest = $derived(cheapestPrice(data.printings, currency));
	let image = $derived((card.local_image_path || card.image_uri || '') as string);
	let socialImage = $derived(image ? new URL(image, SITE_URL).href : undefined);
	let colors: string[] = $derived(card.color_identity ? JSON.parse(card.color_identity as string) : []);
	let sets = $derived(new Set(data.printings.map((p) => p.set_code)).size);
</script>

<svelte:head>
	<!-- No site suffix: Google shows the site name above the result, the facts need the room. -->
	<title>{meta.title}</title>
	<meta name="description" content={meta.description} />
	<link rel="canonical" href={canonical} />
	<meta property="og:title" content={meta.title} />
	<meta property="og:description" content={meta.description} />
	<meta property="og:type" content="website" />
	<meta property="og:url" content={canonical} />
	{#if socialImage}
		<meta property="og:image" content={socialImage} />
		<meta property="og:image:alt" content={name} />
		<meta name="twitter:card" content="summary_large_image" />
	{/if}
	{@html `<script type="application/ld+json">${jsonLd({
		'@context': 'https://schema.org',
		'@graph': [
			{
				'@type': 'WebPage',
				'@id': canonical,
				url: canonical,
				name: meta.title,
				description: meta.description,
				image: socialImage,
				inLanguage: 'en',
				breadcrumb: { '@id': canonical + '#breadcrumb' }
			},
			{
				'@type': 'BreadcrumbList',
				'@id': canonical + '#breadcrumb',
				itemListElement: [
					{ '@type': 'ListItem', position: 1, name: 'MTG Collector', item: SITE_URL + '/' },
					{ '@type': 'ListItem', position: 2, name: 'Cards', item: SITE_URL + '/cards' },
					{ '@type': 'ListItem', position: 3, name, item: canonical }
				]
			}
		]
	})}</script>`}
</svelte:head>

<article class="space-y-6">
	<nav aria-label="Breadcrumb" class="flex flex-wrap gap-2 text-sm text-[var(--color-text-muted)]">
		<a href="/" class="text-[var(--color-primary)] hover:underline">MTG Collector</a>
		<span aria-hidden="true">/</span>
		<a href="/cards" class="text-[var(--color-primary)] hover:underline">Cards</a>
		<span aria-hidden="true">/</span>
		<span aria-current="page">{name}</span>
	</nav>

	<div class="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4 md:gap-8">
		<div>
			{#if image}
				<img src={image} alt="Magic: The Gathering - {name}" width="488" height="680" class="w-full rounded-lg shadow-lg aspect-[488/680] object-cover" loading="eager" fetchpriority="high" />
			{:else}
				<div class="w-full aspect-[488/680] bg-[var(--color-surface)] rounded-lg flex items-center justify-center text-[var(--color-text-muted)]">
					No image
				</div>
			{/if}
		</div>

		<section class="space-y-5">
			<div>
				<p class="eyebrow">Magic: The Gathering card</p>
				<h1 class="mt-1 text-3xl font-semibold text-[var(--color-text-strong)]">{name}</h1>
				<div class="flex flex-wrap items-center gap-3 mt-2">
					{#if card.mana_cost}
						<ManaCost cost={card.mana_cost as string} />
					{/if}
					<span class="chip">{data.printings.length} printing{data.printings.length === 1 ? '' : 's'} in {sets} set{sets === 1 ? '' : 's'}</span>
					{#if cheapest}
						<span class="chip">from <span class="text-[var(--color-accent)] font-semibold">{cheapest.text}</span>{cheapest.foil ? ' (foil)' : ''}</span>
					{/if}
				</div>
			</div>

			{#if data.faces.length > 1}
				{#each data.faces as face}
					<div class="panel p-4 space-y-2">
						<h2 class="font-semibold">{face.name}</h2>
						{#if face.mana_cost}
							<ManaCost cost={face.mana_cost as string} />
						{/if}
						{#if face.type_line}
							<p class="font-medium">{face.type_line}</p>
						{/if}
						{#if face.oracle_text}
							<p class="text-[var(--color-text-muted)] whitespace-pre-line">{face.oracle_text}</p>
						{/if}
						{#if face.power && face.toughness}
							<p class="font-bold">{face.power}/{face.toughness}</p>
						{/if}
					</div>
				{/each}
			{:else}
				<div class="panel p-4 space-y-3">
					{#if card.type_line}
						<p class="font-medium">{card.type_line}</p>
					{/if}
					{#if card.oracle_text}
						<p class="text-[var(--color-text-muted)] whitespace-pre-line">{card.oracle_text}</p>
					{/if}
					{#if card.power && card.toughness}
						<p class="font-bold text-lg">{card.power}/{card.toughness}</p>
					{/if}
					{#if card.loyalty}
						<p class="font-bold text-lg">Loyalty: {card.loyalty}</p>
					{/if}
				</div>
			{/if}

			{#if data.printedNames.length > 0}
				<div class="text-sm">
					<h2 class="text-[var(--color-text-muted)] mb-1">Printed names in other languages</h2>
					<p>
						{#each data.printedNames as printed, i}
							{i > 0 ? ' · ' : ''}<span lang={printed.lang}>{printed.printed_name}</span>
							<span class="text-[var(--color-text-muted)]">({LANGUAGES[printed.lang] ?? printed.lang})</span>
						{/each}
					</p>
				</div>
			{/if}

			{#if colors.length > 0}
				<div class="flex items-center gap-2">
					<span class="text-sm text-[var(--color-text-muted)]">Color identity</span>
					<ColorPips {colors} />
				</div>
			{/if}

			<FormatLegality legalities={card.legalities as string | null} />
		</section>
	</div>

	<section aria-labelledby="printings-heading" class="space-y-3">
		<h2 id="printings-heading" class="text-xl font-semibold text-[var(--color-text-strong)]">
			All printings and prices ({data.printings.length})
		</h2>
		<p class="text-sm text-[var(--color-text-muted)]">
			Reference prices from Cardmarket (EUR) and TCGplayer (USD) via Scryfall. Open a printing for its price history or to add it to your collection.
		</p>
		<ul class="panel divide-y divide-[var(--color-border)]">
			{#each data.printings as printing (printing.id)}
				<li>
					<a href="/cards/{printing.id}" class="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 px-4 py-3 no-underline hover:bg-[var(--color-surface)] sm:grid-cols-[1fr_6rem_6rem]">
						<span class="min-w-0">
							<span class="font-medium text-[var(--color-text)]">{printing.set_name}</span>
							<span class="block text-xs text-[var(--color-text-muted)]">
								{printing.set_code.toUpperCase()} #{printing.collector_number}
								· <span class="rarity-dot inline-block align-middle" style="background: {getRarityColor(printing.rarity)}"></span> {printing.rarity}
								{#if printing.released_at}· {printing.released_at.slice(0, 4)}{/if}
							</span>
						</span>
						<span class="text-right text-sm">
							<span class="block text-xs text-[var(--color-text-muted)]">Price</span>
							<span class="text-[var(--color-accent)]">{formatQuote(printing.price_eur, printing.price_usd, currency)}</span>
						</span>
						<span class="col-start-2 text-right text-sm sm:col-start-3">
							<span class="block text-xs text-[var(--color-text-muted)]">Foil</span>
							<span class="text-[var(--color-accent)]">{formatQuote(printing.price_eur_foil, printing.price_usd_foil, currency)}</span>
						</span>
					</a>
				</li>
			{/each}
		</ul>
	</section>
</article>
