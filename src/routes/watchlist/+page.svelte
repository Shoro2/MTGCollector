<script lang="ts">
	import type { PageData } from './$types';
	import { goto, invalidate } from '$app/navigation';
	import { cardImageError, cardImageSrc, cardImageSrcset } from '$lib/card-image';
	import { currencyMarket, currencySymbol, formatMoney, formatMoneyGrouped, parseCurrency, type Currency } from '$lib/currency';
	import { formatPercent, MAX_ENTRIES, MAX_LIST_NAME, MAX_LISTS, MAX_NOTES, type Change, type WatchRow, type WatchSort } from '$lib/watchlist';
	import { priceDate } from '$lib/utils';
	import type { CardSuggestion } from '$lib/deck';
	import CardPreview from '$lib/components/CardPreview.svelte';
	import CardSearchInput from '$lib/components/CardSearchInput.svelte';

	let { data }: { data: PageData } = $props();

	const currency = $derived(parseCurrency(data.currency));
	const view = $derived(data.view);
	const lists = $derived(data.lists);
	const activeList = $derived(view ? lists.find((l) => l.id === view.list.id) ?? null : null);

	type Answer = { success: boolean; message?: string; id?: number; listId?: number };
	async function send(url: string, method: string, body: object): Promise<Answer> {
		try {
			const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
			const answer = (await response.json().catch(() => null)) as Answer | null;
			return answer ?? { success: false, message: `The server answered ${response.status}.` };
		} catch {
			return { success: false, message: 'No connection to the server.' };
		}
	}

	// Lists
	let newListOpen = $state(false);
	let newListName = $state('');
	let listBusy = $state(false);
	let listError = $state('');

	async function createList(event: SubmitEvent) {
		event.preventDefault();
		listBusy = true;
		listError = '';
		const answer = await send('/api/watchlists', 'POST', { name: newListName });
		listBusy = false;
		if (!answer.success) {
			listError = answer.message ?? 'The list could not be created.';
			return;
		}
		newListName = '';
		newListOpen = false;
		await goto(`/watchlist?list=${answer.id}`, { invalidateAll: true });
	}

	let renameDialog = $state<HTMLDialogElement>(null!);
	let renameName = $state('');
	let deleteDialog = $state<HTMLDialogElement>(null!);

	function openRename() {
		renameName = view?.list.name ?? '';
		listError = '';
		renameDialog.showModal();
	}

	async function renameList(event: SubmitEvent) {
		event.preventDefault();
		if (!view) return;
		listBusy = true;
		const answer = await send('/api/watchlists', 'PATCH', { id: view.list.id, name: renameName });
		listBusy = false;
		if (!answer.success) {
			listError = answer.message ?? 'The list could not be renamed.';
			return;
		}
		renameDialog.close();
		await invalidate('app:watchlist');
	}

	async function deleteList() {
		if (!view) return;
		listBusy = true;
		const answer = await send('/api/watchlists', 'DELETE', { id: view.list.id });
		listBusy = false;
		deleteDialog.close();
		if (answer.success) await goto('/watchlist', { invalidateAll: true });
	}

	// Adding a printing
	type Printing = { id: string; set_code: string; set_name: string; collector_number: string; price_eur: number | null; price_eur_foil: number | null; price_usd: number | null; price_usd_foil: number | null };
	let picked = $state<CardSuggestion | null>(null);
	let printings = $state<Printing[]>([]);
	let printingId = $state('');
	let addFoil = $state(false);
	let addBusy = $state(false);
	let addError = $state('');
	let addNote = $state('');
	const chosenPrinting = $derived(printings.find((p) => p.id === printingId) ?? null);

	async function pick(card: CardSuggestion) {
		picked = card;
		printingId = card.id;
		addError = '';
		addNote = '';
		printings = [];
		const response = await fetch(`/api/decks/printings?card=${encodeURIComponent(card.id)}`).catch(() => null);
		if (response?.ok) printings = ((await response.json()) as { printings: Printing[] }).printings;
		// A printing that only exists in foil is watched in foil.
		const chosen = printings.find((p) => p.id === printingId);
		addFoil = !!chosen && chosen.price_eur == null && chosen.price_usd == null && (chosen.price_eur_foil != null || chosen.price_usd_foil != null);
	}

	function printingLabel(p: Printing) {
		const regular = formatQuoteShort(p.price_eur, p.price_usd);
		const foil = formatQuoteShort(p.price_eur_foil, p.price_usd_foil);
		return `${p.set_name} (${p.set_code.toUpperCase()}) #${p.collector_number}: ${regular}${foil !== '-' ? `, foil ${foil}` : ''}`;
	}

	function formatQuoteShort(eur: number | null, usd: number | null) {
		const own = currency === 'USD' ? usd : eur;
		const other = currency === 'USD' ? eur : usd;
		if (own != null) return formatMoney(own, currency);
		if (other != null) return formatMoney(other, currency === 'USD' ? 'EUR' : 'USD');
		return '-';
	}

	async function addEntry(event: SubmitEvent) {
		event.preventDefault();
		if (!printingId) return;
		addBusy = true;
		addError = '';
		const answer = await send('/api/watchlists/cards', 'POST', { cardId: printingId, foil: addFoil, listId: view?.list.id ?? null });
		addBusy = false;
		if (!answer.success) {
			addError = answer.message ?? 'The card could not be added.';
			return;
		}
		addNote = `${picked?.name ?? 'The card'} is on the list.`;
		picked = null;
		printings = [];
		printingId = '';
		if (!view && answer.listId) await goto(`/watchlist?list=${answer.listId}`, { invalidateAll: true });
		else await invalidate('app:watchlist');
	}

	// Editing an entry
	let editDialog = $state<HTMLDialogElement>(null!);
	let editing = $state<WatchRow | null>(null);
	let editFoil = $state(false);
	let editTarget = $state<number | string | null>('');
	let editTargetCurrency = $state<Currency>('EUR');
	let editDirection = $state<'below' | 'above'>('below');
	let editNotes = $state('');
	let editList = $state(0);
	let editBusy = $state(false);
	let editError = $state('');

	function openEdit(row: WatchRow) {
		editing = row;
		editFoil = row.foil;
		editTarget = row.targetPrice;
		editTargetCurrency = row.targetPrice == null ? currency : row.targetCurrency;
		editDirection = row.targetDirection;
		editNotes = row.notes;
		editList = row.listId;
		editError = '';
		editDialog.showModal();
	}

	async function saveEdit(event: SubmitEvent) {
		event.preventDefault();
		if (!editing) return;
		editBusy = true;
		editError = '';
		const answer = await send('/api/watchlists/cards', 'PATCH', {
			rowId: editing.id,
			foil: editFoil,
			targetPrice: editTarget == null || String(editTarget).trim() === '' ? null : String(editTarget).trim(),
			targetCurrency: editTargetCurrency,
			targetDirection: editDirection,
			notes: editNotes,
			listId: editList
		});
		editBusy = false;
		if (!answer.success) {
			editError = answer.message ?? 'The entry could not be saved.';
			return;
		}
		editDialog.close();
		await invalidate('app:watchlist');
	}

	let removing = $state<number | null>(null);
	async function removeEntry(row: WatchRow) {
		removing = row.id;
		await send('/api/watchlists/cards', 'DELETE', { rowId: row.id });
		removing = null;
		await invalidate('app:watchlist');
	}

	// Sorting lives in the URL, like every list in the app.
	function sortHref(key: WatchSort) {
		const params = new URLSearchParams();
		if (view) params.set('list', String(view.list.id));
		const dir = data.sort === key ? (data.dir === 'asc' ? 'desc' : 'asc') : key === 'name' ? 'asc' : 'desc';
		params.set('sort', key);
		params.set('dir', dir);
		return `/watchlist?${params}`;
	}
	const arrow = (key: WatchSort) => (data.sort === key ? (data.dir === 'asc' ? ' ▲' : ' ▼') : '');

	function signed(amount: number, market: Currency) {
		if (amount === 0) return formatMoney(0, market);
		return `${amount > 0 ? '+' : '−'}${formatMoney(Math.abs(amount), market)}`;
	}
	function tone(c: Change | null) {
		if (!c || c.amount === 0) return 'text-[var(--color-text-muted)]';
		return c.amount > 0 ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]';
	}
	function imageOf(row: WatchRow) {
		if (row.localImagePath) return row.localImagePath;
		return row.imageUri ? cardImageSrc(row.imageUri) : '';
	}

	const SORTS: Array<{ key: WatchSort; label: string }> = [
		{ key: 'added', label: 'Added' },
		{ key: 'name', label: 'Name' },
		{ key: 'price', label: 'Price' },
		{ key: 'day', label: 'Day' },
		{ key: 'week', label: '7 days' },
		{ key: 'month', label: '30 days' },
		{ key: 'since', label: 'Since added' },
		{ key: 'target', label: 'Target' }
	];
</script>

<svelte:head>
	<title>Watchlist | MTG Collector</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

{#snippet changeCell(c: Change | null, market: Currency | null, label: string)}
	{#if c && market}
		<span class="tabular whitespace-nowrap {tone(c)}" title={label}>
			{signed(c.amount, market)}{#if c.percent != null}<span class="ml-1 text-[0.7rem]">{formatPercent(c.percent)}</span>{/if}
		</span>
	{:else}
		<span class="text-[var(--color-text-faint)]" title="{label}: no price to compare">-</span>
	{/if}
{/snippet}

{#snippet spark(row: WatchRow)}
	{#if row.spark}
		<svg viewBox="0 0 120 32" class="h-8 w-[7.5rem]" role="img" aria-label="Price over 90 days: low {formatMoney(row.spark.low, row.market!)}, high {formatMoney(row.spark.high, row.market!)}" data-spark>
			<path d={row.spark.path} fill="none" stroke-width="1.6" stroke-linejoin="round"
				stroke={row.spark.rising == null ? 'var(--color-text-muted)' : row.spark.rising ? 'var(--color-success)' : 'var(--color-danger)'} />
		</svg>
	{:else}
		<span class="text-xs text-[var(--color-text-faint)]">no history</span>
	{/if}
{/snippet}

{#snippet targetChip(row: WatchRow)}
	{#if row.targetPrice != null}
		<span
			class="chip whitespace-nowrap"
			style={row.target ? 'border-color: var(--color-success); color: var(--color-success)' : undefined}
			data-target={row.target == null ? 'unknown' : row.target ? 'reached' : 'waiting'}
			title={row.target == null ? `No ${currencyMarket(row.targetCurrency)} price to compare` : row.target ? 'Target reached' : 'Target not reached yet'}
		>
			{row.targetDirection === 'below' ? '≤' : '≥'} {formatMoney(row.targetPrice, row.targetCurrency)}{#if row.target} ✓{/if}
		</span>
	{/if}
{/snippet}

{#snippet priceCell(row: WatchRow)}
	<span class="price font-semibold text-[var(--color-accent)]" data-price>{row.market ? formatMoney(row.price, row.market) : '-'}</span>
	{#if row.otherMarket}
		<span class="block text-[0.65rem] text-[var(--color-text-faint)]">no {currencyMarket(currency)} price</span>
	{/if}
{/snippet}

<div class="space-y-5">
	<div class="page-heading">
		<div class="min-w-0">
			<p class="eyebrow">Prices</p>
			<h1 class="mt-1 text-[1.375rem] font-semibold text-[var(--color-text-strong)]">Watchlist</h1>
			<p class="mt-1 text-sm text-[var(--color-text-muted)]">
				Follow the prices of printings you do not own yet, want to sell or just keep an eye on.
				Prices come from the daily update: {currencyMarket(currency)} in {currency === 'USD' ? 'US dollars' : 'euros'} (change it in <a href="/settings" class="text-[var(--color-primary)] hover:underline">Settings</a>).
			</p>
		</div>
	</div>

	<!-- Lists -->
	<div class="flex flex-wrap items-center gap-2" data-watchlists>
		{#each lists as list (list.id)}
			<a
				href="/watchlist?list={list.id}"
				class="btn min-h-8 {view?.list.id === list.id ? 'btn-primary' : ''}"
				aria-current={view?.list.id === list.id ? 'page' : undefined}
			>
				<span class="max-w-[12rem] truncate">{list.name}</span>
				<span class="tabular text-[0.7rem] opacity-80">{list.entries}</span>
			</a>
		{/each}
		{#if lists.length < MAX_LISTS}
			{#if newListOpen}
				<form onsubmit={createList} class="flex min-w-0 items-center gap-2">
					<input
						bind:value={newListName}
						maxlength={MAX_LIST_NAME}
						placeholder="List name"
						aria-label="New list name"
						class="control min-w-0 w-40 px-2 text-sm"
						data-new-list-name
					/>
					<button type="submit" class="btn btn-primary min-h-8" disabled={listBusy || !newListName.trim()}>Create</button>
					<button type="button" class="btn min-h-8" onclick={() => { newListOpen = false; listError = ''; }}>Cancel</button>
				</form>
			{:else}
				<button type="button" class="btn min-h-8" onclick={() => (newListOpen = true)} data-new-list>+ New list</button>
			{/if}
		{/if}
		{#if view}
			<span class="ml-auto flex gap-2">
				<button type="button" class="btn min-h-8" onclick={openRename}>Rename</button>
				<button type="button" class="btn btn-danger min-h-8" onclick={() => deleteDialog.showModal()}>Delete list</button>
			</span>
		{/if}
	</div>
	{#if listError && !renameDialog?.open}
		<p class="text-sm text-[var(--color-danger)]" role="alert">{listError}</p>
	{/if}

	<!-- Add a printing -->
	<section class="panel space-y-3 p-4" aria-labelledby="watch-add-heading">
		<h2 id="watch-add-heading" class="text-sm font-semibold text-[var(--color-text-strong)]">
			{view ? `Add a card to ${view.list.name}` : 'Add a card'}
		</h2>
		{#if !view || (activeList && activeList.entries < MAX_ENTRIES)}
			<CardSearchInput label="Card name" placeholder="Search a card to watch…" onselect={pick} />
			{#if picked}
				<form onsubmit={addEntry} class="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end" data-add-form>
					<label class="min-w-0 text-sm">
						<span class="mb-1 block text-xs text-[var(--color-text-muted)]">Printing of {picked.name}</span>
						<select bind:value={printingId} class="control w-full min-w-0 px-2 text-sm" data-add-printing>
							{#if !printings.length}<option value={picked.id}>{picked.name} ({picked.set_code.toUpperCase()})</option>{/if}
							{#each printings as p (p.id)}
								<option value={p.id}>{printingLabel(p)}</option>
							{/each}
						</select>
					</label>
					<label class="flex items-center gap-2 text-sm sm:pb-2">
						<input type="checkbox" bind:checked={addFoil} class="rounded" data-add-foil />
						Foil
						{#if chosenPrinting && addFoil && chosenPrinting.price_eur_foil == null && chosenPrinting.price_usd_foil == null}
							<span class="text-xs text-[var(--color-text-faint)]">(no foil price yet)</span>
						{/if}
					</label>
					<button type="submit" class="btn btn-primary" disabled={addBusy} data-add-submit>{addBusy ? 'Adding…' : 'Watch price'}</button>
				</form>
			{/if}
		{:else}
			<p class="text-sm text-[var(--color-text-muted)]">This list holds {MAX_ENTRIES} cards, the most a list can hold. Start another list.</p>
		{/if}
		{#if addError}<p class="text-sm text-[var(--color-danger)]" role="alert">{addError}</p>{/if}
		{#if addNote}<p class="text-sm text-[var(--color-success)]" role="status">{addNote}</p>{/if}
		<p class="text-xs text-[var(--color-text-faint)]">You can also add a printing from its page with "Watch price".</p>
	</section>

	{#if !view}
		<div class="panel p-8 text-center" data-empty>
			<p class="text-[var(--color-text-muted)]">You do not watch any card yet.</p>
			<p class="mt-1 text-sm text-[var(--color-text-faint)]">Search a card above, or open a printing from <a href="/cards" class="text-[var(--color-primary)] hover:underline">the card database</a> and press "Watch price". Your first list is created with it.</p>
		</div>
	{:else}
		<!-- Totals -->
		<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
			<div class="kpi-card">
				<p class="kpi-label">List value</p>
				<p class="kpi-value" data-kpi="value">{formatMoneyGrouped(view.totals.value, currency)}</p>
				<p class="kpi-subtle">one copy each, {view.totals.priced} priced{#if view.totals.unpriced}, {view.totals.unpriced} without a price{/if}</p>
			</div>
			<div class="kpi-card">
				<p class="kpi-label">Since the update before</p>
				<p class="kpi-value {view.totals.dayMove > 0 ? 'text-[var(--color-success)]' : view.totals.dayMove < 0 ? 'text-[var(--color-danger)]' : ''}" data-kpi="day">
					{view.totals.dayCompared ? signed(view.totals.dayMove, currency) : '-'}
				</p>
				<p class="kpi-subtle">
					{#if view.refs.latest && view.refs.previous}{priceDate(view.refs.previous)} to {priceDate(view.refs.latest)}{:else}no earlier update{/if}
				</p>
			</div>
			<div class="kpi-card">
				<p class="kpi-label">Targets reached</p>
				<p class="kpi-value" data-kpi="targets">{view.totals.targetsReached}</p>
				<p class="kpi-subtle">set a target price with Edit</p>
			</div>
		</div>

		{#if view.rows.length}
			<!-- Sort -->
			<nav class="toolbar" aria-label="Sort the list">
				<span class="text-xs text-[var(--color-text-muted)]">Sort</span>
				{#each SORTS as s (s.key)}
					<a href={sortHref(s.key)} class="btn min-h-8 {data.sort === s.key ? 'btn-primary' : ''}" data-sort={s.key}>{s.label}{arrow(s.key)}</a>
				{/each}
			</nav>

			<!-- Wide screens: a table -->
			<div class="panel hidden overflow-x-auto md:block">
				<table class="w-full text-sm" data-watch-table>
					<thead>
						<tr class="text-left text-xs text-[var(--color-text-muted)]">
							<th class="px-3 py-2 font-semibold">Card</th>
							<th class="px-3 py-2 text-right font-semibold">Price</th>
							<th class="px-3 py-2 text-right font-semibold">Day</th>
							<th class="px-3 py-2 text-right font-semibold">7 days</th>
							<th class="px-3 py-2 text-right font-semibold">30 days</th>
							<th class="px-3 py-2 text-right font-semibold">Since added</th>
							<th class="px-3 py-2 font-semibold">90 days</th>
							<th class="px-3 py-2 font-semibold">Target</th>
							<th class="px-3 py-2"><span class="sr-only">Actions</span></th>
						</tr>
					</thead>
					<tbody>
						{#each view.rows as row (row.id)}
							{@const img = imageOf(row)}
							<tr class="border-t border-[var(--color-border)] align-middle" data-watch-row={row.cardId} data-foil={row.foil ? '1' : '0'}>
								<td class="px-3 py-2">
									<div class="flex min-w-0 items-center gap-3">
										{#if img}
											<CardPreview src={img} alt={row.name} scale={2.4}>
												<a href="/cards/{row.cardId}">
													<img onerror={cardImageError} src={img} srcset={row.localImagePath ? undefined : cardImageSrcset(row.imageUri) ?? undefined} sizes="40px" alt={row.name} class="h-14 w-10 flex-shrink-0 rounded object-cover" loading="lazy" />
												</a>
											</CardPreview>
										{/if}
										<div class="min-w-0">
											<a href="/cards/{row.cardId}" class="font-semibold hover:text-[var(--color-primary)]">{row.name}</a>
											<p class="text-xs text-[var(--color-text-muted)]">
												<span class="set-code">{row.setCode.toUpperCase()}</span> #{row.collectorNumber}
												{#if row.foil}<span class="foil-chip ml-1">Foil</span>{/if}
											</p>
											{#if row.notes}<p class="max-w-[18rem] truncate text-xs italic text-[var(--color-text-faint)]" title={row.notes}>{row.notes}</p>{/if}
										</div>
									</div>
								</td>
								<td class="px-3 py-2 text-right">{@render priceCell(row)}</td>
								<td class="px-3 py-2 text-right" data-change="day">{@render changeCell(row.day, row.market, 'Since the update before')}</td>
								<td class="px-3 py-2 text-right">{@render changeCell(row.week, row.market, 'Last 7 days')}</td>
								<td class="px-3 py-2 text-right">{@render changeCell(row.month, row.market, 'Last 30 days')}</td>
								<td class="px-3 py-2 text-right">
									{@render changeCell(row.sinceAdded, row.market, `Since ${priceDate(row.addedAt)}`)}
									<span class="block text-[0.65rem] text-[var(--color-text-faint)]">{priceDate(row.addedAt)}</span>
								</td>
								<td class="px-3 py-2"><a href="/cards/{row.cardId}#price-history" title="Open the price chart">{@render spark(row)}</a></td>
								<td class="px-3 py-2">{@render targetChip(row)}</td>
								<td class="px-3 py-2 text-right whitespace-nowrap">
									<button type="button" class="btn min-h-8" onclick={() => openEdit(row)} data-edit>Edit</button>
									<button type="button" class="btn btn-danger min-h-8" onclick={() => removeEntry(row)} disabled={removing === row.id} aria-label="Stop watching {row.name}" data-remove>✕</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<!-- Phones: one panel per card -->
			<div class="grid grid-cols-1 gap-2 md:hidden" data-watch-cards>
				{#each view.rows as row (row.id)}
					{@const img = imageOf(row)}
					<article class="panel min-w-0 p-3" data-watch-card={row.cardId}>
						<div class="flex min-w-0 items-start gap-3">
							{#if img}
								<a href="/cards/{row.cardId}" class="flex-shrink-0">
									<img onerror={cardImageError} src={img} srcset={row.localImagePath ? undefined : cardImageSrcset(row.imageUri) ?? undefined} sizes="48px" alt={row.name} class="h-16 w-12 rounded object-cover" loading="lazy" />
								</a>
							{/if}
							<div class="min-w-0 flex-1">
								<div class="flex min-w-0 items-start justify-between gap-2">
									<a href="/cards/{row.cardId}" class="min-w-0 break-words font-semibold hover:text-[var(--color-primary)]">{row.name}</a>
									<span class="text-right">{@render priceCell(row)}</span>
								</div>
								<p class="text-xs text-[var(--color-text-muted)]">
									<span class="set-code">{row.setCode.toUpperCase()}</span> #{row.collectorNumber}
									{#if row.foil}<span class="foil-chip ml-1">Foil</span>{/if}
								</p>
								{#if row.notes}<p class="truncate text-xs italic text-[var(--color-text-faint)]">{row.notes}</p>{/if}
							</div>
						</div>
						<dl class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
							<div class="flex justify-between gap-2"><dt class="text-[var(--color-text-muted)]">Day</dt><dd>{@render changeCell(row.day, row.market, 'Since the update before')}</dd></div>
							<div class="flex justify-between gap-2"><dt class="text-[var(--color-text-muted)]">7 days</dt><dd>{@render changeCell(row.week, row.market, 'Last 7 days')}</dd></div>
							<div class="flex justify-between gap-2"><dt class="text-[var(--color-text-muted)]">30 days</dt><dd>{@render changeCell(row.month, row.market, 'Last 30 days')}</dd></div>
							<div class="flex justify-between gap-2"><dt class="text-[var(--color-text-muted)]">Since added</dt><dd>{@render changeCell(row.sinceAdded, row.market, `Since ${priceDate(row.addedAt)}`)}</dd></div>
						</dl>
						<div class="mt-2 flex flex-wrap items-center justify-between gap-2">
							<a href="/cards/{row.cardId}#price-history" title="Open the price chart">{@render spark(row)}</a>
							{@render targetChip(row)}
							<span class="flex gap-2">
								<button type="button" class="btn min-h-8" onclick={() => openEdit(row)}>Edit</button>
								<button type="button" class="btn btn-danger min-h-8" onclick={() => removeEntry(row)} disabled={removing === row.id} aria-label="Stop watching {row.name}">✕</button>
							</span>
						</div>
					</article>
				{/each}
			</div>
		{:else}
			<div class="panel p-8 text-center" data-empty-list>
				<p class="text-[var(--color-text-muted)]">This list is empty. Search a card above to watch its price.</p>
			</div>
		{/if}
	{/if}
</div>

<!-- Edit an entry -->
<dialog bind:this={editDialog} class="panel-raised w-[min(28rem,calc(100vw-2rem))] p-0 text-[var(--color-text)] backdrop:bg-black/60" data-edit-dialog>
	{#if editing}
		<form onsubmit={saveEdit} class="space-y-4 p-5">
			<div>
				<h2 class="text-base font-semibold text-[var(--color-text-strong)]">{editing.name}</h2>
				<p class="text-xs text-[var(--color-text-muted)]">{editing.setName} #{editing.collectorNumber}</p>
			</div>
			<label class="flex items-center gap-2 text-sm">
				<input type="checkbox" bind:checked={editFoil} class="rounded" data-edit-foil />
				Watch the foil price
			</label>
			<fieldset class="space-y-2">
				<legend class="text-xs text-[var(--color-text-muted)]">Target price (optional)</legend>
				<div class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
					<select bind:value={editDirection} class="control px-2 text-sm" aria-label="Target direction" data-edit-direction>
						<option value="below">at or below</option>
						<option value="above">at or above</option>
					</select>
					<input type="number" step="0.01" min="0" bind:value={editTarget} placeholder="e.g. 12.50" class="control min-w-0 px-2 text-sm" aria-label="Target price" data-edit-target />
					<select bind:value={editTargetCurrency} class="control px-2 text-sm" aria-label="Target currency" data-edit-target-currency>
						<option value="EUR">{currencySymbol('EUR')} Cardmarket</option>
						<option value="USD">{currencySymbol('USD')} TCGplayer</option>
					</select>
				</div>
				<p class="text-xs text-[var(--color-text-faint)]">Compared with that market's price only, never converted. The list marks the card when the target is reached.</p>
			</fieldset>
			<label class="block text-sm">
				<span class="mb-1 block text-xs text-[var(--color-text-muted)]">Note</span>
				<textarea bind:value={editNotes} maxlength={MAX_NOTES} rows="2" class="control w-full px-2 py-1 text-sm" data-edit-notes></textarea>
			</label>
			{#if lists.length > 1}
				<label class="block text-sm">
					<span class="mb-1 block text-xs text-[var(--color-text-muted)]">List</span>
					<select bind:value={editList} class="control w-full px-2 text-sm" data-edit-list>
						{#each lists as list (list.id)}<option value={list.id}>{list.name}</option>{/each}
					</select>
				</label>
			{/if}
			{#if editError}<p class="text-sm text-[var(--color-danger)]" role="alert">{editError}</p>{/if}
			<div class="flex justify-end gap-2">
				<button type="button" class="btn" onclick={() => editDialog.close()}>Cancel</button>
				<button type="submit" class="btn btn-primary" disabled={editBusy} data-edit-save>{editBusy ? 'Saving…' : 'Save'}</button>
			</div>
		</form>
	{/if}
</dialog>

<!-- Rename the list -->
<dialog bind:this={renameDialog} class="panel-raised w-[min(24rem,calc(100vw-2rem))] p-0 text-[var(--color-text)] backdrop:bg-black/60">
	<form onsubmit={renameList} class="space-y-4 p-5">
		<h2 class="text-base font-semibold text-[var(--color-text-strong)]">Rename the list</h2>
		<input bind:value={renameName} maxlength={MAX_LIST_NAME} aria-label="List name" class="control w-full px-2 text-sm" />
		{#if listError}<p class="text-sm text-[var(--color-danger)]" role="alert">{listError}</p>{/if}
		<div class="flex justify-end gap-2">
			<button type="button" class="btn" onclick={() => renameDialog.close()}>Cancel</button>
			<button type="submit" class="btn btn-primary" disabled={listBusy || !renameName.trim()}>Save</button>
		</div>
	</form>
</dialog>

<!-- Delete the list -->
<dialog bind:this={deleteDialog} class="panel-raised w-[min(24rem,calc(100vw-2rem))] p-0 text-[var(--color-text)] backdrop:bg-black/60" data-delete-dialog>
	<div class="space-y-4 p-5">
		<h2 class="text-base font-semibold text-[var(--color-text-strong)]">Delete "{view?.list.name}"?</h2>
		<p class="text-sm text-[var(--color-text-muted)]">The list and its {activeList?.entries ?? 0} cards are removed. Your collection, wishlist and decks are not touched.</p>
		<div class="flex justify-end gap-2">
			<button type="button" class="btn" onclick={() => deleteDialog.close()}>Cancel</button>
			<button type="button" class="btn btn-danger" onclick={deleteList} disabled={listBusy} data-delete-confirm>Delete list</button>
		</div>
	</div>
</dialog>
