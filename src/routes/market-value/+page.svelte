<script lang="ts">
	import { onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import type { Chart } from 'chart.js';
	import { loadChart } from '$lib/chart-loader';
	import { lineChartOptions } from '$lib/chart-options';
	import { currencyMarket, currencySymbol, formatMoneyWhole } from '$lib/currency';
	import { axisDate, longDate, MARKET_RANGES, MARKET_VIEWS, marketHref, marketSeries, monthLabel, type MarketFilter } from '$lib/market-history';

	// The detail view behind the homepage's market panel: the chart with its filters and
	// the same days per month. Filters live in the URL, and the links, the date form and
	// the table work without JavaScript.
	// Visitor-facing copy: no dashes, no marketing phrases (owner's rule).
	let { data } = $props();

	const filter = $derived(data.filter);
	const currency = $derived(filter.currency);
	const period = $derived(data.period);
	const whole = (amount: number) => formatMoneyWhole(amount, currency);
	const count = (n: number) => n.toLocaleString('en-US');
	const signedCount = (n: number) => `${n > 0 ? '+' : '−'}${count(Math.abs(n))}`;
	const changeClass = (n: number | null) => n == null || n === 0 ? 'text-[var(--color-text-muted)]' : n > 0 ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]';
	const signedMoney = (n: number) => n === 0 ? whole(0) : `${n > 0 ? '+' : '−'}${whole(Math.abs(n))}`;
	const signedPct = (n: number | null) => n == null ? '' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(2)}%`;
	const href = (change: Partial<MarketFilter>) => marketHref({ ...filter, ...change }, data.viewerCurrency);
	const source = $derived(currency === 'USD' ? `${currencyMarket(currency)} market price` : `${currencyMarket(currency)} trend price`);
	// "every Magic card" or "The Lord of the Rings (LTR)"
	const subject = $derived(data.setName ? `${data.setName} (${filter.set?.toUpperCase()})` : 'every Magic card');
	const title = $derived(data.setName ? `Market value of ${data.setName} (${filter.set?.toUpperCase()}) per month` : 'Market value of every Magic card per month');

	let canvas = $state<HTMLCanvasElement>();
	let chart: Chart | null = null;
	let drawing = 0;

	// Redraws when the filters bring new days. A newer draw makes an older one still loading Chart.js give up.
	$effect(() => {
		const target = canvas;
		const view = filter.view;
		const { dates, values } = marketSeries(data.points, view);
		const money = view !== 'printings';
		const dots = data.points.length <= 40;
		const run = ++drawing;
		if (!target) return;
		loadChart().then((ChartCtor) => {
			if (run !== drawing) return;
			chart?.destroy();
			const crossesYears = dates.length > 0 && dates[0].slice(0, 4) !== dates[dates.length - 1].slice(0, 4);
			const options = lineChartOptions({ euro: money, currency });
			options.plugins = {
				...options.plugins,
				legend: { display: false },
				tooltip: {
					callbacks: {
						label: (item) => {
							const n = item.parsed.y ?? 0;
							if (!money) return `${count(n)} printings`;
							return view === 'change' ? signedMoney(n) : whole(n);
						}
					}
				}
			};
			chart = new ChartCtor(target, {
				type: 'line',
				data: {
					labels: dates.map((d) => axisDate(d, crossesYears)),
					datasets: [{
						label: MARKET_VIEWS.find((v) => v.id === view)?.label ?? '',
						data: values,
						borderColor: view === 'change' ? '#94a3b8' : '#f59e0b',
						borderWidth: 2,
						spanGaps: true,
						pointRadius: dots ? 2.5 : 0,
						pointHitRadius: 10,
						cubicInterpolationMode: 'monotone',
						...(view === 'change'
							? { fill: { target: { value: 0 }, above: 'rgba(34, 197, 94, 0.25)', below: 'rgba(239, 68, 68, 0.25)' } }
							: { fill: false })
					}]
				},
				options
			});
		});
	});

	onDestroy(() => {
		drawing++;
		chart?.destroy();
	});

	const pill = (active: boolean) => `rounded-md px-3 py-1.5 text-center text-sm transition-colors ${active
		? 'bg-[var(--color-primary)] text-white'
		: 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`;
	const group = 'grid w-full gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-0.5 sm:inline-grid sm:w-auto sm:grid-flow-col sm:auto-cols-auto sm:grid-cols-none';
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={data.setName
		? `The value of one copy of every printing of ${data.setName} over time, from Cardmarket and TCGplayer prices, as a chart and a table per month.`
		: 'The value of one copy of every Magic: The Gathering printing over time, from Cardmarket and TCGplayer prices, as a chart and a table per month.'} />
	<link rel="canonical" href={data.seo.canonical} />
	{#if data.seo.noindex}<meta name="robots" content="noindex, follow" />{/if}
</svelte:head>

<div class="flex min-w-0 flex-col gap-5" data-market-page data-currency={currency} data-market-set={filter.set ?? ''}>
	<header class="flex flex-col gap-1">
		<a href="/" class="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]">‹ Home</a>
		<h1 class="text-2xl font-semibold text-[var(--color-text-strong)]">Market value of {subject}</h1>
		<p class="text-sm text-[var(--color-text-muted)]">
			One copy of each {data.setName ? 'English printing of the set' : 'printing'} with a {source} (non foil, or foil when it only exists in foil), added up on every price update. {currencyMarket(currency)} prices in {currencySymbol(currency)}, never converted.
		</p>
	</header>

	<!-- The filters: every choice is a link, so it can be shared and works without JavaScript. -->
	<section aria-label="Filters" class="panel flex flex-col gap-3 p-4" data-market-filters>
		<div class="flex flex-wrap items-center gap-x-4 gap-y-3">
			<div role="group" aria-label="Period" class="{group} grid-cols-3">
				{#each MARKET_RANGES as range (range.id)}
					<a href={href({ range: range.id, from: null, to: null })} data-market-range={range.id} data-sveltekit-noscroll
						aria-current={filter.range === range.id ? 'true' : undefined} class={pill(filter.range === range.id)}>{range.label}</a>
				{/each}
			</div>
			<div role="group" aria-label="Market" class="{group} grid-cols-2">
				{#each [{ id: 'EUR', label: 'Cardmarket €' }, { id: 'USD', label: 'TCGplayer $' }] as const as market (market.id)}
					<a href={href({ currency: market.id })} data-market-currency={market.id} data-sveltekit-noscroll
						aria-current={currency === market.id ? 'true' : undefined} class={pill(currency === market.id)}>{market.label}</a>
				{/each}
			</div>
		</div>
		<!-- The set: a GET form like the dates; with JavaScript a choice opens its link at once. -->
		<form method="GET" action="/market-value" class="flex flex-wrap items-end gap-3" data-market-set-form data-sveltekit-noscroll>
			<label class="flex min-w-0 flex-1 flex-col gap-1 text-xs text-[var(--color-text-muted)] sm:max-w-sm">
				Set
				<select name="set" value={filter.set ?? ''} class="control min-w-0 px-2 text-sm" data-market-set-select
					onchange={(e) => goto(href({ set: e.currentTarget.value || null }), { noScroll: true, keepFocus: true })}>
					<option value="">Every set</option>
					{#each data.sets as set (set.code)}
						<option value={set.code}>{set.name} ({set.code.toUpperCase()})</option>
					{/each}
				</select>
			</label>
			{#if filter.range === 'custom'}
				{#if filter.from}<input type="hidden" name="from" value={filter.from} />{/if}
				{#if filter.to}<input type="hidden" name="to" value={filter.to} />{/if}
			{:else if filter.range !== 'all'}
				<input type="hidden" name="range" value={filter.range} />
			{/if}
			{#if currency !== data.viewerCurrency}<input type="hidden" name="currency" value={currency} />{/if}
			{#if filter.view !== 'value'}<input type="hidden" name="view" value={filter.view} />{/if}
			<noscript><button type="submit" class="btn">Show set</button></noscript>
		</form>
		<form method="GET" action="/market-value" class="flex flex-wrap items-end gap-3" data-market-dates data-sveltekit-noscroll>
			<label class="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
				From
				<input type="date" name="from" value={filter.range === 'custom' ? filter.from : ''} min={data.firstDate} max={data.lastDate} class="control px-2 text-sm" />
			</label>
			<label class="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
				To
				<input type="date" name="to" value={filter.range === 'custom' ? filter.to : ''} min={data.firstDate} max={data.lastDate} class="control px-2 text-sm" />
			</label>
			{#if filter.set}<input type="hidden" name="set" value={filter.set} />{/if}
			{#if currency !== data.viewerCurrency}<input type="hidden" name="currency" value={currency} />{/if}
			{#if filter.view !== 'value'}<input type="hidden" name="view" value={filter.view} />{/if}
			<button type="submit" class="btn">Apply dates</button>
		</form>
	</section>

	{#if period}
		<section aria-label="The period's figures" class="grid grid-cols-2 gap-3 lg:grid-cols-4" data-market-period>
			<div class="kpi-card min-w-0">
				<p class="kpi-label">Value on {longDate(period.to)}</p>
				<p class="kpi-value text-[var(--color-accent)]" data-period-value>{whole(period.value)}</p>
			</div>
			<div class="kpi-card min-w-0">
				<p class="kpi-label">Change since {longDate(period.from)}</p>
				{#if period.change != null}
					<p class="kpi-value {changeClass(period.change)}" data-period-change>{signedMoney(period.change)}</p>
					<p class="text-xs text-[var(--color-text-muted)]">{signedPct(period.changePct)}</p>
				{:else}
					<p class="kpi-value text-[var(--color-text-muted)]" data-period-change>None yet</p>
				{/if}
			</div>
			<div class="kpi-card min-w-0">
				<p class="kpi-label">Highest and lowest</p>
				<p class="kpi-value" data-period-high>{whole(period.high)}</p>
				<p class="text-xs text-[var(--color-text-muted)]" data-period-low>Lowest {whole(period.low)}</p>
			</div>
			<div class="kpi-card min-w-0">
				<p class="kpi-label">Printings priced</p>
				<p class="kpi-value" data-period-printings>{count(period.printings)}</p>
				<p class="text-xs text-[var(--color-text-muted)]">
					{period.newPrintings === 0 ? 'No change' : `${signedCount(period.newPrintings)} in this period`}, {count(period.updates)} {period.updates === 1 ? 'update' : 'updates'}
				</p>
			</div>
		</section>

		<section aria-labelledby="market-chart-heading" class="panel flex min-w-0 flex-col gap-3 p-4" data-market-chart-panel>
			<div class="flex flex-wrap items-center justify-between gap-3">
				<h2 id="market-chart-heading" class="text-base font-semibold text-[var(--color-text-strong)]">
					{MARKET_VIEWS.find((v) => v.id === filter.view)?.label}, {longDate(period.from)} to {longDate(period.to)}
				</h2>
				<div role="group" aria-label="Chart view" class="{group} grid-cols-1">
					{#each MARKET_VIEWS as view (view.id)}
						<a href={href({ view: view.id })} data-market-view={view.id} data-sveltekit-noscroll
							aria-current={filter.view === view.id ? 'true' : undefined} class={pill(filter.view === view.id)}>{view.label}</a>
					{/each}
				</div>
			</div>
			<div class="chart-frame" role="img" aria-label="{MARKET_VIEWS.find((v) => v.id === filter.view)?.label} from {longDate(period.from)} to {longDate(period.to)}. The table below has the same days per month.">
				<canvas bind:this={canvas} data-market-canvas></canvas>
			</div>
			<p class="text-xs text-[var(--color-text-muted)]">
				{#if filter.view === 'change'}
					What the printings priced on both updates gained or lost since the update before.
				{:else if filter.view === 'printings'}
					{data.setName ? 'Printings of the set gain a price, and a printing can lose its price.' : 'New sets add printings, and a printing can lose its price.'}
				{:else if data.setName}
					The total also rises when printings of the set get their first price. The change above and in the table counts only printings priced on both updates.
				{:else}
					The total also rises when printings get their first price, from a new set or an older printing. The change above and in the table counts only printings priced on both updates.
				{/if}
			</p>
		</section>

		<section aria-labelledby="market-months-heading" class="flex min-w-0 flex-col gap-2" data-market-months>
			<h2 id="market-months-heading" class="text-base font-semibold text-[var(--color-text-strong)]">Values per month</h2>
			<div class="panel overflow-hidden">
				<table class="w-full text-sm">
					<thead class="text-left text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
						<tr class="border-b border-[var(--color-border)]">
							<th scope="col" class="px-3 py-3 sm:px-4">Month</th>
							<th scope="col" class="px-3 py-3 text-right">Last value</th>
							<th scope="col" class="px-3 py-3 text-right sm:px-4 md:px-3">Change</th>
							<th scope="col" class="hidden px-3 py-3 text-right md:table-cell">Highest</th>
							<th scope="col" class="hidden px-3 py-3 text-right md:table-cell">Lowest</th>
							<th scope="col" class="hidden px-3 py-3 text-right sm:table-cell">Printings</th>
							<th scope="col" class="hidden px-4 py-3 text-right lg:table-cell">Updates</th>
						</tr>
					</thead>
					<tbody>
						{#each data.months as row (row.month)}
							<tr class="border-b border-[var(--color-border-subtle)] last:border-0" data-market-month={row.month}>
								<th scope="row" class="px-3 py-2.5 text-left sm:px-4">{monthLabel(row.month)}</th>
								<td class="tabular px-3 py-2.5 text-right text-[var(--color-accent)]" data-month-value>{whole(row.value)}</td>
								<td class="tabular px-3 py-2.5 text-right sm:px-4 md:px-3 {changeClass(row.change)}" data-month-change>
									{#if row.change == null}
										<span class="text-[var(--color-text-faint)]">n/a</span>
									{:else}
										{signedMoney(row.change)}
										{#if row.changePct != null}<span class="block text-xs md:inline md:pl-1">({signedPct(row.changePct)})</span>{/if}
									{/if}
								</td>
								<td class="tabular hidden px-3 py-2.5 text-right md:table-cell">{whole(row.high)}</td>
								<td class="tabular hidden px-3 py-2.5 text-right md:table-cell">{whole(row.low)}</td>
								<td class="tabular hidden px-3 py-2.5 text-right sm:table-cell">
									{count(row.printings)}{#if row.newPrintings !== 0}<span class="block text-xs text-[var(--color-text-muted)] md:inline md:pl-1">({signedCount(row.newPrintings)})</span>{/if}
								</td>
								<td class="tabular hidden px-4 py-2.5 text-right lg:table-cell">{row.updates}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p class="text-xs text-[var(--color-text-muted)]">
				The last value is the month's last price update. The change counts printings priced on both updates, and the months add up to the change above.
			</p>
		</section>
	{:else}
		<p class="panel p-5 text-sm text-[var(--color-text-muted)]" data-market-empty>
			{data.lastDate ? 'No price update in this period.' : filter.set ? 'This set has no prices yet.' : 'The values fill in with the next price updates.'}
		</p>
	{/if}
</div>
