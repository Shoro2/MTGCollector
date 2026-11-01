<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { DEFAULT_LIST_NAME } from '$lib/watchlist';

	/**
	 * "Watch price" on a printing page: shows the lists that watch this printing and adds
	 * it to one of the user's price watchlists (/watchlist), in its regular or foil finish.
	 */
	let {
		cardId,
		hasRegularPrice,
		hasFoilPrice,
		watches,
		lists
	}: {
		cardId: string;
		hasRegularPrice: boolean;
		hasFoilPrice: boolean;
		watches: Array<{ id: number; listId: number; listName: string; foil: number }>;
		lists: Array<{ id: number; name: string; entries: number }>;
	} = $props();

	let open = $state(false);
	let listId = $state<number | ''>('');
	let foil = $state(false);
	let busy = $state(false);
	let message = $state('');

	function start() {
		open = true;
		message = '';
		listId = lists[0]?.id ?? '';
		// A printing that only exists in foil is watched in foil.
		foil = !hasRegularPrice && hasFoilPrice;
	}

	async function send(method: string, body: object) {
		busy = true;
		message = '';
		try {
			const response = await fetch('/api/watchlists/cards', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
			const answer = (await response.json().catch(() => null)) as { success: boolean; message?: string } | null;
			if (!answer?.success) {
				message = answer?.message ?? `The server answered ${response.status}.`;
				return false;
			}
			return true;
		} catch {
			message = 'No connection to the server.';
			return false;
		} finally {
			busy = false;
		}
	}

	async function add(event: SubmitEvent) {
		event.preventDefault();
		if (await send('POST', { cardId, foil, listId: listId === '' ? null : listId })) {
			open = false;
			await invalidate('app:card-detail');
		}
	}

	async function remove(id: number) {
		if (await send('DELETE', { rowId: id })) await invalidate('app:card-detail');
	}
</script>

<section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm" data-watch-price>
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h3 class="font-semibold">Price watchlist</h3>
		{#if !open}
			<button type="button" class="btn min-h-8" onclick={start} data-watch-open>👁 Watch price</button>
		{/if}
	</div>
	{#if watches.length}
		<ul class="mt-2 flex flex-wrap gap-2">
			{#each watches as w (w.id)}
				<li class="chip" data-watched={w.listId}>
					<a href="/watchlist?list={w.listId}" class="hover:text-[var(--color-primary)]">Watched in {w.listName}{w.foil ? ' (foil)' : ''}</a>
					<button type="button" onclick={() => remove(w.id)} disabled={busy} aria-label="Stop watching in {w.listName}" class="text-[var(--color-text-faint)] hover:text-[var(--color-danger)]">✕</button>
				</li>
			{/each}
		</ul>
	{:else if !open}
		<p class="mt-1 text-xs text-[var(--color-text-muted)]">Follow this printing's price on your <a href="/watchlist" class="text-[var(--color-primary)] hover:underline">watchlist</a> without adding it to your collection.</p>
	{/if}
	{#if open}
		<form onsubmit={add} class="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center" data-watch-form>
			<select bind:value={listId} class="control min-w-0 px-2 text-sm" aria-label="List" data-watch-list>
				{#each lists as list (list.id)}<option value={list.id}>{list.name} ({list.entries})</option>{/each}
				{#if !lists.length}<option value="">{DEFAULT_LIST_NAME} (new)</option>{/if}
			</select>
			<select bind:value={foil} class="control px-2 text-sm" aria-label="Finish" data-watch-finish>
				<option value={false}>Regular{hasRegularPrice ? '' : ' (no price)'}</option>
				<option value={true}>Foil{hasFoilPrice ? '' : ' (no price)'}</option>
			</select>
			<span class="flex gap-2">
				<button type="submit" class="btn btn-primary min-h-8" disabled={busy} data-watch-submit>Watch</button>
				<button type="button" class="btn min-h-8" onclick={() => (open = false)}>Cancel</button>
			</span>
		</form>
	{/if}
	{#if message}<p class="mt-2 text-xs text-[var(--color-danger)]" role="alert">{message}</p>{/if}
</section>
