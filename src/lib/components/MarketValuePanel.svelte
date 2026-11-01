<script lang="ts">
	import { compactMoney, currencyMarket, formatMoneyGrouped, type Currency } from '$lib/currency';
	import { shortDate, type marketSummary } from '$lib/home';

	// The homepage panel with the market value of every printing (src/lib/server/market-value.ts).
	// Visitor-facing copy: no dashes, no marketing phrases (owner's rule).
	let { market, currency }: { market: NonNullable<ReturnType<typeof marketSummary>>; currency: Currency } = $props();

	const whole = (amount: number) => formatMoneyGrouped(Math.round(amount), currency).replace(/\.00$/, '');
	const trend = $derived(market.change == null ? '' : market.change > 0 ? 'up' : market.change < 0 ? 'down' : 'flat');
	const source = $derived(currency === 'USD' ? `${currencyMarket(currency)} market price` : `${currencyMarket(currency)} trend price`);
</script>

<section aria-labelledby="market-value" class="panel grid gap-4 p-5 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:items-center" data-market-panel data-currency={currency}>
	<div class="flex min-w-0 flex-col gap-1.5">
		<h2 id="market-value" class="text-base font-semibold text-[var(--color-text-strong)]">Market value of every Magic card</h2>
		<p class="kpi-value text-[var(--color-accent)]" data-market-value>{whole(market.value)}</p>
		{#if market.change != null && market.previousDate}
			<p
				class="text-sm font-semibold {trend === 'up' ? 'text-[var(--color-success)]' : trend === 'down' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}"
				data-market-change={trend}
			>
				{#if trend === 'flat'}
					No change since {shortDate(market.previousDate)}
				{:else}
					{trend === 'up' ? '▲' : '▼'} {whole(Math.abs(market.change))}{#if market.changePct != null}&nbsp;({market.changePct > 0 ? '+' : '−'}{Math.abs(market.changePct).toFixed(2)}%){/if}
					since {shortDate(market.previousDate)}
				{/if}
			</p>
		{/if}
		<p class="text-xs text-[var(--color-text-muted)]">
			One copy of each of the {market.printings.toLocaleString('en-US')} {market.printings === 1 ? 'printing' : 'printings'} with a {source} on {shortDate(market.date)}.
			{#if market.change != null && market.newPrintings > 0}
				The change counts the printings priced on both days; {market.newPrintings.toLocaleString('en-US')} more have a price now.
			{/if}
		</p>
	</div>

	{#if market.chart}
		{@const chart = market.chart}
		<div class="flex min-w-0 flex-col gap-1">
			<div class="flex min-w-0 gap-2">
				<svg
					viewBox="0 0 320 80"
					role="img"
					aria-label="Market value from {whole(chart.low)} to {whole(chart.high)} between {shortDate(chart.from)} and {shortDate(chart.to)}"
					class="block h-[6.5rem] min-w-0 flex-1"
					preserveAspectRatio="none"
					data-market-chart
				>
					<path d={chart.area} fill="var(--color-accent)" fill-opacity="0.08" stroke="none"></path>
					<path d={chart.line} fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"></path>
				</svg>
				<div class="tabular flex shrink-0 flex-col justify-between text-right text-[0.6875rem] text-[var(--color-text-muted)]" aria-hidden="true">
					<span>{compactMoney(chart.high, currency)}</span>
					<span>{compactMoney(chart.low, currency)}</span>
				</div>
			</div>
			<div class="flex justify-between text-[0.6875rem] text-[var(--color-text-muted)]" aria-hidden="true">
				<span>{shortDate(chart.from)}</span>
				<span>{shortDate(chart.to)}</span>
			</div>
		</div>
	{:else}
		<p class="text-sm text-[var(--color-text-muted)]">The chart fills in with the next price updates.</p>
	{/if}
</section>
