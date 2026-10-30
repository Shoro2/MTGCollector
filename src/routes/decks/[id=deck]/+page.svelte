<script lang="ts">
	import type { PageData } from './$types';
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import ColorPips from '$lib/components/ColorPips.svelte';
	import ManaCost from '$lib/components/ManaCost.svelte';
	import CardSearchInput from '$lib/components/CardSearchInput.svelte';
	import DeckCardEdit from '$lib/components/DeckCardEdit.svelte';
	import DeckSettings from '$lib/components/DeckSettings.svelte';
	import DeckImport from '$lib/components/DeckImport.svelte';
	import DeckExport from '$lib/components/DeckExport.svelte';
	import DeckBracket from '$lib/components/DeckBracket.svelte';
	import DeckReport from '$lib/components/DeckReport.svelte';
	import { BOARDS, BOARD_LABELS, VISIBILITY_LABELS, groupDeck, ownershipRank, timeAgo, type Board, type CardSuggestion, type GroupBy, type SortBy } from '$lib/deck';
	import { formatPrice } from '$lib/utils';
	import { SITE_URL } from '$lib/seo';

	let { data }: { data: PageData } = $props();
	type Row = PageData['rows'][number];

	const GROUPS: Record<GroupBy, string> = { type: 'Card type', cmc: 'Mana value', none: 'None' };
	// "Owned" compares the deck with the viewer's collection, so only signed-in viewers get it.
	const SORTS = $derived<Partial<Record<SortBy, string>>>({ name: 'Name', cmc: 'Mana value', price: 'Price', ...(data.signedIn ? { owned: 'Owned' } : {}) });
	const param = (key: string) => page.url.searchParams.get(key) ?? '';
	const group = $derived((param('group') in GROUPS ? param('group') : 'type') as GroupBy);
	const sort = $derived((param('sort') in SORTS ? param('sort') : 'name') as SortBy);
	const groups = $derived(groupDeck(data.rows, group, sort, (r) => r.unit, (r) => ownershipRank(r.owned)));

	const deck = $derived(data.deck);
	const lead = $derived(data.rows.find((r) => r.board === 'commander') ?? data.rows.find((r) => r.board === 'main') ?? null);
	let hovered = $state<Row | null>(null);
	const preview = $derived(hovered ?? lead);
	const image = (row: Row | null) => (row ? row.local_image_path || row.image_uri : null);
	// Social previews need an absolute URL; a locally stored image is a path on this site.
	const socialImage = $derived.by(() => {
		const src = image(lead);
		return src?.startsWith('/') ? SITE_URL + src : src;
	});

	const counts = $derived(data.totals.counts);
	const deckSize = $derived(counts.commander + counts.main);
	const problemCards = $derived.by(() => {
		const map = new Map<string, string>();
		for (const problem of data.check.problems) for (const name of problem.cards) if (!map.has(name)) map.set(name, problem.message);
		return map;
	});
	// The rules skip the maybeboard, and in commander formats the sideboard too.
	const checked = (row: Row) => row.board !== 'maybeboard' && !(data.check.kind === 'commander' && row.board === 'sideboard');
	const plural = (n: number, word: string, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;
	const curveMax = $derived(Math.max(1, ...data.curve));

	let editing = $state<Row | null>(null);
	let settings = $state<{ hint: string } | null>(null);
	let importing = $state(false);
	let exporting = $state(false);
	let reporting = $state(false);
	let addBoard = $state<Board>('main');
	let status = $state('');
	let failure = $state('');
	let busy = $state(false);

	const refresh = () => invalidate('app:deck');

	function view(changes: Record<string, string>) {
		const params = new URLSearchParams(page.url.searchParams);
		for (const [key, value] of Object.entries(changes)) {
			if (value) params.set(key, value);
			else params.delete(key);
		}
		goto(`${page.url.pathname}${params.size ? `?${params}` : ''}`, { replaceState: true, keepFocus: true, noScroll: true });
	}

	async function post(url: string, body?: Record<string, unknown>) {
		busy = true;
		status = '';
		failure = '';
		try {
			const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
			const result = await response.json().catch(() => ({}));
			if (!response.ok || !result.success) throw new Error(result.message || 'The change was not saved.');
			return result;
		} catch (error) {
			failure = (error as Error).message;
			return null;
		} finally {
			busy = false;
		}
	}

	async function addCard(card: CardSuggestion) {
		if (await post(`/api/decks/${deck.id}/cards`, { cardId: card.id, board: addBoard })) {
			await refresh();
			status = `Added ${card.name} to the ${BOARD_LABELS[addBoard].toLowerCase()}.`;
		}
	}

	async function addPartner(card: CardSuggestion) {
		if (await post(`/api/decks/${deck.id}/cards`, { cardId: card.id, board: 'commander' })) {
			await refresh();
			status = `${card.name} joins the command zone.`;
		}
	}

	// A two-color card splits its frame between both colors; every other frame is a single class.
	const frameStyle = (row: Row) =>
		row.frame.kind === 'dual' ? `--frame-a: var(--pip-${row.frame.colors[0].toLowerCase()}); --frame-b: var(--pip-${row.frame.colors[1].toLowerCase()})` : undefined;

	async function copyDeck() {
		const result = await post(`/api/decks/${deck.id}/copy`);
		if (result) await goto(`/decks/${result.id}`);
	}

	async function share() {
		status = '';
		failure = '';
		if (deck.visibility === 'private') {
			settings = { hint: 'This deck is private. Make it unlisted or public, then share its link.' };
			return;
		}
		try {
			await navigator.clipboard.writeText(`${page.url.origin}/decks/${deck.id}`);
			status = 'Link copied. Anyone with the link can view this deck, without your name or collection.';
		} catch {
			status = `Share this link: ${page.url.origin}/decks/${deck.id}`;
		}
	}

	const OWNERSHIP_TITLES = {
		owned: 'In your collection, this printing included',
		proxy: 'In your collection as proxies',
		partial: 'Partly in your collection',
		missing: 'Not in your collection'
	} as const;
	function ownershipTitle(row: Row) {
		const own = row.owned!;
		if (own.state === 'owned' && !own.printing) return 'In your collection as another printing';
		if (own.state !== 'partial') return OWNERSHIP_TITLES[own.state];
		return `You have ${own.real} real${own.proxy ? ` and ${own.proxy} proxy` : ''} of ${row.quantity}`;
	}
	const lineTitle = (row: Row) => (row.unit == null ? 'No price' : `${row.quantity} × ${formatPrice(row.unit)}`);
	const linePrice = (row: Row) => (row.unit == null ? '-' : formatPrice(Math.round(row.unit * row.quantity * 100) / 100));
</script>

<svelte:head>
	<!-- Public decks of a real size are indexed (deck-seo.ts); unlisted, hidden and small decks are not. -->
	<title>{data.seo.title}</title>
	<meta name="description" content={data.seo.description} />
	{#if data.seo.indexable}
		<link rel="canonical" href={data.seo.canonical} />
	{:else}
		<meta name="robots" content="noindex, nofollow" />
	{/if}
	<meta property="og:title" content={data.seo.title} />
	<meta property="og:description" content={data.seo.description} />
	<meta property="og:type" content="website" />
	<meta property="og:url" content={data.seo.canonical} />
	{#if socialImage}
		<meta property="og:image" content={socialImage} />
		<meta property="og:image:alt" content={lead?.name} />
	{/if}
</svelte:head>

<div class="space-y-5" data-deck={deck.id}>
	<div class="panel flex flex-col gap-4 p-4 sm:flex-row sm:items-start">
		{#if image(lead)}
			<img src={image(lead)} alt={lead?.name} class="hidden w-24 shrink-0 rounded-lg sm:block lg:hidden" loading="lazy" />
		{/if}
		<div class="min-w-0 flex-1">
			<p class="eyebrow">{data.check.formatLabel} deck</p>
			<h1 class="mt-1 break-words text-[1.375rem] font-semibold text-[var(--color-text-strong)]">
				{deck.name}
				{#if data.check.kind === 'commander'}<DeckBracket bracket={deck.bracket} />{/if}
				{#if data.isOwner}<span class="chip ml-1 min-h-0 px-1.5 py-0 align-middle text-[0.62rem] uppercase">{VISIBILITY_LABELS[deck.visibility]}</span>{/if}
			</h1>
			<p class="mt-1 flex flex-wrap items-center gap-2 text-sm text-[var(--color-text-muted)]">
				<ColorPips colors={data.colors} includeColorless />
				{#if deck.author_name}<span data-deck-author>by <span class="text-[var(--color-text)]">{deck.author_name}</span></span>{/if}
				<span title={new Date(deck.updated_at).toLocaleString()}>Updated {timeAgo(deck.updated_at)}</span>
			</p>
			{#if deck.description}<p class="mt-3 whitespace-pre-line break-words text-sm">{deck.description}</p>{/if}
			{#if deck.hidden}
				<p class="mt-3 rounded-lg border border-[var(--color-accent-muted)] p-3 text-sm" data-hidden-note>
					{#if data.isOwner}
						Several players reported this deck. Its description and author name are hidden from them, and it is not in the public deck list.
					{:else}
						This deck's description and author name are hidden after reports from several players.
					{/if}
				</p>
			{/if}
		</div>
		<div class="flex flex-wrap gap-2 sm:max-w-[45%] sm:justify-end">
			{#if data.isOwner}
				<button type="button" onclick={share} class="btn btn-primary">Share</button>
				<button type="button" onclick={() => (importing = true)} class="btn">Import</button>
				<button type="button" onclick={() => (exporting = true)} class="btn">Export</button>
				<button type="button" onclick={() => (settings = { hint: '' })} class="btn">Settings</button>
				<button type="button" onclick={copyDeck} disabled={busy} class="btn">Duplicate</button>
			{:else}
				{#if data.signedIn}
					<button type="button" onclick={copyDeck} disabled={busy} class="btn btn-primary">Copy to my decks</button>
				{:else}
					<a href="/login" class="btn btn-primary">Sign in to copy</a>
				{/if}
				<button type="button" onclick={() => (exporting = true)} class="btn">Export</button>
				{#if data.signedIn}
					<button type="button" onclick={() => (reporting = true)} disabled={data.reported} class="btn" title={data.reported ? 'You reported this deck' : undefined}>
						{data.reported ? 'Reported' : 'Report'}
					</button>
				{/if}
			{/if}
		</div>
	</div>

	{#if status}<p role="status" class="text-sm text-[var(--color-success)]">{status}</p>{/if}
	{#if failure}<p role="alert" class="text-sm text-[var(--color-danger)]">{failure}</p>{/if}

	<div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
		<div class="kpi-card">
			<p class="kpi-label">Cards</p>
			<p class="kpi-value" data-kpi="cards">{deckSize}</p>
			<p class="kpi-subtle">
				{counts.sideboard} sideboard{#if counts.maybeboard}, {counts.maybeboard} maybe{/if}
			</p>
		</div>
		<div class="kpi-card">
			<p class="kpi-label">Value</p>
			<p class="kpi-value text-[var(--color-accent)]" data-kpi="value">{formatPrice(data.totals.value)}</p>
			<p class="kpi-subtle">{data.totals.unpriced ? `${plural(data.totals.unpriced, 'copy', 'copies')} without a price` : 'Deck and sideboard'}</p>
		</div>
		<div class="kpi-card">
			<p class="kpi-label">Still to buy</p>
			{#if data.signedIn && data.totals.missingValue != null}
				<p class="kpi-value" data-kpi="missing">{formatPrice(data.totals.missingValue)}</p>
				<p class="kpi-subtle">
					{data.totals.missingCards ? `${data.totals.missingCards} not in your collection` : 'You own every card'}{#if data.totals.proxyCards}, {data.totals.proxyCards} as proxies{/if}{#if data.totals.missingUnpriced}, {data.totals.missingUnpriced} unpriced{/if}
				</p>
			{:else}
				<p class="kpi-subtle mt-2"><a href="/login" class="text-[var(--color-primary)] hover:underline">Sign in</a> to compare the deck with your collection.</p>
			{/if}
		</div>
		<div class="kpi-card">
			<p class="kpi-label">{data.check.formatLabel}</p>
			{#if data.check.kind === 'casual'}
				<p class="kpi-value">Casual</p>
				<p class="kpi-subtle">No format rules are checked</p>
			{:else if data.check.problems.length === 0}
				<p class="kpi-value text-[var(--color-success)]" data-kpi="legality">Legal</p>
				<p class="kpi-subtle">{data.check.unchecked.length ? `${plural(data.check.unchecked.length, 'card')} without legality data` : 'Size, copies, bans and colors'}</p>
			{:else}
				<p class="kpi-value text-[var(--color-danger)]" data-kpi="legality">{plural(data.check.problems.length, 'problem')}</p>
				<p class="kpi-subtle">See the list below</p>
			{/if}
		</div>
	</div>

	{#if data.check.problems.length || data.check.unchecked.length}
		<div class="panel p-4 text-sm" data-problems>
			{#if data.check.problems.length}
				<h2 class="font-semibold text-[var(--color-danger)]">Not legal in {data.check.formatLabel}</h2>
				<ul class="mt-2 list-disc space-y-1 pl-5">
					{#each data.check.problems as problem, i (i)}
						<li>{problem.message}{#if problem.cards.length}{' '}<span class="text-[var(--color-text-muted)]">{problem.cards.join(', ')}</span>{/if}</li>
					{/each}
				</ul>
			{/if}
			{#if data.check.unchecked.length}
				<p class="mt-2 text-[var(--color-text-muted)]">Without legality data for this format: {data.check.unchecked.join(', ')}.</p>
			{/if}
		</div>
	{/if}

	{#if data.isOwner}
		<div class="toolbar flex-wrap items-end">
			<div class="min-w-[min(100%,18rem)] flex-1">
				<CardSearchInput label="Add a card" placeholder="Search by card name…" format={deck.format} clearOnSelect disabled={busy} onselect={addCard} />
			</div>
			<label class="text-sm">
				<span class="text-[var(--color-text-muted)]">to</span>
				<select bind:value={addBoard} aria-label="Board for new cards" class="control mt-1 block px-2 text-sm">
					{#each BOARDS as b (b)}<option value={b}>{BOARD_LABELS[b]}</option>{/each}
				</select>
			</label>
		</div>
	{/if}

	{#if data.partnerOf}
		<div class="toolbar flex-wrap items-end" data-add-partner>
			<div class="min-w-[min(100%,18rem)] flex-1">
				<CardSearchInput
					label="Add a partner for {data.partnerOf.name}"
					placeholder="Second commander…"
					format={deck.format}
					partnerOf={data.partnerOf.cardId}
					clearOnSelect
					disabled={busy}
					onselect={addPartner}
				/>
			</div>
			<p class="text-xs text-[var(--color-text-muted)] sm:max-w-[16rem]">Only cards that can share the command zone with it are offered.</p>
		</div>
	{/if}

	{#if data.rows.length === 0}
		<div class="panel p-8 text-center text-[var(--color-text-muted)]">
			{#if data.isOwner}
				<p>This deck has no cards yet.</p>
				<p class="mt-1 text-sm">Add cards with the search above, or import a list from Moxfield, MTG Arena or MTGO.</p>
				<button type="button" onclick={() => (importing = true)} class="btn btn-primary mt-4">Import a list</button>
			{:else}
				<p>This deck has no cards yet.</p>
			{/if}
		</div>
	{:else}
		<div class="flex flex-wrap items-center gap-3 text-sm text-[var(--color-text-muted)]">
			<label class="flex items-center gap-2">
				Group by
				<select value={group} onchange={(e) => view({ group: e.currentTarget.value === 'type' ? '' : e.currentTarget.value })} class="control px-2 text-sm">
					{#each Object.entries(GROUPS) as [value, label] (value)}<option {value}>{label}</option>{/each}
				</select>
			</label>
			<label class="flex items-center gap-2">
				Sort by
				<select value={sort} onchange={(e) => view({ sort: e.currentTarget.value === 'name' ? '' : e.currentTarget.value })} class="control px-2 text-sm">
					{#each Object.entries(SORTS) as [value, label] (value)}<option {value}>{label}</option>{/each}
				</select>
			</label>
			{#if data.signedIn}
				<span class="ml-auto text-xs">
					<span class="text-[var(--color-success)]">✓</span> owned · <span class="font-semibold text-[var(--color-success)]">≈</span> other printing · <span class="text-[var(--color-accent-muted)]">P</span> proxy · <span class="text-[var(--color-text-faint)]">○</span> missing
				</span>
			{/if}
		</div>

		<div class="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_15rem]">
			<div class="columns-1 gap-5 md:columns-2">
				{#each groups as g (g.key)}
					<section class="mb-5 break-inside-avoid" data-group={g.key}>
						<h2 class="flex items-baseline justify-between border-b border-[var(--color-border)] pb-1 text-sm font-semibold">
							<span>{g.label} <span class="tabular font-normal text-[var(--color-text-muted)]">({g.count})</span></span>
						</h2>
						<ul class="mt-2 space-y-1">
							{#each g.rows as row (row.id)}
								<li
									class="deck-card frame-{row.frame.kind} flex items-center gap-2 py-1 pr-1 text-sm"
									style={frameStyle(row)}
									data-row={row.name}
									data-frame={row.frame.kind}
									onpointerenter={() => (hovered = row)}
									onfocusin={() => (hovered = row)}
								>
									<span class="tabular w-5 shrink-0 text-right font-semibold text-[var(--color-text-strong)]">{row.quantity}</span>
									<a href="/cards/{row.card_id}" class="min-w-0 flex-1 truncate font-medium text-[var(--color-text-strong)] hover:text-[var(--color-primary)]" title="{row.name} · {row.set_code.toUpperCase()} #{row.collector_number}">{row.name}</a>
									{#if checked(row) && problemCards.has(row.name)}
										<span class="shrink-0 font-bold text-[var(--color-danger)]" title={problemCards.get(row.name)} aria-label="Problem: {problemCards.get(row.name)}">!</span>
									{/if}
									{#if row.foil}<span class="foil-chip shrink-0">Foil</span>{/if}
									<span class="hidden shrink-0 sm:inline-flex"><ManaCost cost={row.mana_cost} /></span>
									{#if row.owned}
										<span class="w-7 shrink-0 text-center text-xs" data-owned={row.owned.state} data-printing={row.owned.printing ? 'this' : 'other'} title={ownershipTitle(row)} aria-label={ownershipTitle(row)}>
											{#if row.owned.state === 'owned' && row.owned.printing}<span class="text-[var(--color-success)]">✓</span>
											{:else if row.owned.state === 'owned'}<span class="font-semibold text-[var(--color-success)]">≈</span>
											{:else if row.owned.state === 'proxy'}<span class="font-semibold text-[var(--color-accent-muted)]">P</span>
											{:else if row.owned.state === 'partial'}<span class="tabular text-[var(--color-accent-muted)]">{row.owned.real + row.owned.proxy}/{row.quantity}</span>
											{:else}<span class="text-[var(--color-text-faint)]">○</span>{/if}
										</span>
									{/if}
									<span class="price w-16 shrink-0 text-right text-xs text-[var(--color-text-muted)]" title={lineTitle(row)}>{linePrice(row)}</span>
									{#if data.isOwner}
										<button type="button" onclick={() => (editing = row)} class="shrink-0 px-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)]" aria-label="Edit {row.name}" title="Edit">✎</button>
									{/if}
								</li>
							{/each}
						</ul>
					</section>
				{/each}
			</div>

			<aside class="space-y-4 lg:sticky lg:top-4 lg:self-start">
				{#if image(preview)}
					<img src={image(preview)} alt={preview?.name} class="hidden w-full rounded-xl shadow-lg lg:block" />
				{/if}
				<div class="panel p-4">
					<h2 class="text-sm font-semibold">Mana curve</h2>
					<div class="mt-3 flex h-24 items-end gap-1" role="img" aria-label="Mana curve: {data.curve.map((n, i) => `${n} at ${i === 7 ? '7 or more' : i}`).join(', ')}">
						{#each data.curve as n, i (i)}
							<div class="flex flex-1 flex-col items-center justify-end gap-1 self-stretch">
								<span class="tabular text-[0.65rem] text-[var(--color-text-muted)]">{n || ''}</span>
								<div class="w-full rounded-t bg-[var(--color-primary)]" style="height: {(n / curveMax) * 70}%; min-height: {n ? 2 : 0}px"></div>
							</div>
						{/each}
					</div>
					<div class="mt-1 flex gap-1 text-center text-[0.65rem] text-[var(--color-text-muted)]">
						{#each data.curve as _, i (i)}<span class="flex-1">{i === 7 ? '7+' : i}</span>{/each}
					</div>
					<p class="mt-2 text-xs text-[var(--color-text-faint)]">Commander and main deck, lands left out.</p>
				</div>
			</aside>
		</div>
	{/if}
</div>

{#if editing}
	<DeckCardEdit deckId={deck.id} row={editing} onclose={() => (editing = null)} onsaved={refresh} />
{/if}
{#if settings}
	<DeckSettings {deck} hint={settings.hint} captchaSiteKey={data.captchaSiteKey} publishBlocked={data.publishBlocked} onclose={() => (settings = null)} onsaved={refresh} />
{/if}
{#if importing}
	<DeckImport deckId={deck.id} onclose={() => (importing = false)} onimported={refresh} />
{/if}
{#if exporting}
	<DeckExport deckId={deck.id} onclose={() => (exporting = false)} />
{/if}
{#if reporting}
	<DeckReport deckId={deck.id} onclose={() => (reporting = false)} onreported={refresh} />
{/if}
