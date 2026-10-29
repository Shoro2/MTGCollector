<script lang="ts">
	import { onMount } from 'svelte';
	import { BOARDS, BOARD_LABELS, type Board } from '$lib/deck';
	import { displayPrice } from '$lib/utils';

	type Row = { id: number; board: Board; quantity: number; foil: number; card_id: string; name: string; set_code: string; collector_number: string };
	type Printing = {
		id: string; set_code: string; set_name: string; collector_number: string; released_at: string | null; is_paper: number | null;
		price_eur: number | null; price_eur_foil: number | null; price_usd: number | null; price_usd_foil: number | null;
		image_uri: string | null; local_image_path: string | null;
	};
	/** Quantity, board, finish and printing of one deck entry, or remove it. */
	let { deckId, row, onclose, onsaved }: { deckId: string; row: Row; onclose: () => void; onsaved: () => Promise<void> } = $props();

	let dialog: HTMLDialogElement;
	let quantity = $state(1);
	let board = $state<Board>('main');
	let foil = $state(false);
	let cardId = $state('');
	let printings = $state<Printing[]>([]);
	// The printing under the pointer or the keyboard focus, else the chosen one, is shown beside the list.
	let pointed = $state<string | null>(null);
	const shown = $derived(printings.find((p) => p.id === (pointed ?? cardId)) ?? null);
	const image = (p: Printing | null) => (p ? p.local_image_path || p.image_uri : null);
	let busy = $state(false);
	let message = $state('');

	onMount(async () => {
		quantity = row.quantity;
		board = row.board;
		foil = !!row.foil;
		cardId = row.card_id;
		dialog.showModal();
		const response = await fetch(`/api/decks/printings?card=${encodeURIComponent(row.card_id)}`);
		if (response.ok) printings = (await response.json()).printings;
	});

	function label(p: Printing) {
		const price = displayPrice(p);
		const year = p.released_at ? ` (${p.released_at.slice(0, 4)})` : '';
		return `${p.set_name}${year} · ${p.set_code.toUpperCase()} #${p.collector_number}${p.is_paper === 0 ? ' · digital' : ''}${price ? ` · ${price.text}${price.foil ? ' foil' : ''}` : ''}`;
	}

	async function send(method: 'PATCH' | 'DELETE', body: Record<string, unknown>) {
		busy = true;
		message = '';
		try {
			const response = await fetch(`/api/decks/${deckId}/cards`, {
				method,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ rowId: row.id, ...body })
			});
			const result = await response.json().catch(() => ({}));
			if (!response.ok || !result.success) throw new Error(result.message || 'The change was not saved.');
			await onsaved();
			dialog.close();
		} catch (error) {
			message = (error as Error).message;
		} finally {
			busy = false;
		}
	}

	function save(event: SubmitEvent) {
		event.preventDefault();
		send('PATCH', { quantity, board, foil, cardId });
	}
</script>

<dialog
	bind:this={dialog}
	onclose={onclose}
	oncancel={(e) => { if (busy) e.preventDefault(); }}
	aria-labelledby="edit-card-title"
	class="w-[calc(100%-2rem)] max-w-2xl max-h-[90dvh] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-[var(--color-text)]"
>
	<div class="mb-4 flex items-start justify-between gap-3">
		<h2 id="edit-card-title" class="text-lg font-semibold">{row.name}</h2>
		<button type="button" onclick={() => dialog.close()} disabled={busy} aria-label="Close" class="btn min-h-8 px-3">×</button>
	</div>
	<form onsubmit={save} class="space-y-4">
		<fieldset disabled={busy} class="space-y-4">
			<div class="grid grid-cols-2 gap-3">
				<label class="block text-sm">
					<span class="text-[var(--color-text-muted)]">Quantity</span>
					<input type="number" min="1" max="999" step="1" required bind:value={quantity} class="control mt-1 block w-full px-3 text-sm" />
				</label>
				<label class="block text-sm">
					<span class="text-[var(--color-text-muted)]">Board</span>
					<select bind:value={board} class="control mt-1 block w-full px-2 text-sm">
						{#each BOARDS as b (b)}<option value={b}>{BOARD_LABELS[b]}</option>{/each}
					</select>
				</label>
			</div>
			<fieldset>
				<legend class="text-sm text-[var(--color-text-muted)]">Printing</legend>
				<div class="mt-1 flex gap-3">
					<div class="max-h-64 min-w-0 flex-1 overflow-y-auto rounded-lg border border-[var(--color-border)]" data-printings>
						{#if !printings.length}
							<p class="px-3 py-2 text-sm text-[var(--color-text-muted)]">{row.set_code.toUpperCase()} #{row.collector_number}</p>
						{/if}
						{#each printings as p (p.id)}
							<label
								class="flex cursor-pointer items-start gap-2 border-b border-[var(--color-border-subtle)] px-3 py-1.5 text-sm last:border-0 hover:bg-[var(--color-surface-hover)] {cardId === p.id ? 'bg-[var(--color-surface-hover)]' : ''}"
								onpointerenter={() => (pointed = p.id)}
								onpointerleave={() => (pointed = null)}
								data-printing={p.id}
							>
								<input type="radio" name="deck-printing" value={p.id} bind:group={cardId} onfocus={() => (pointed = p.id)} onblur={() => (pointed = null)} class="mt-1" />
								<span class="min-w-0">{label(p)}</span>
							</label>
						{/each}
					</div>
					<div class="w-24 shrink-0 sm:w-40">
						{#if image(shown)}
							<img src={image(shown)} alt="{row.name}, {shown?.set_code.toUpperCase()} #{shown?.collector_number}" class="w-full rounded-lg shadow-lg" data-printing-preview={shown?.id} />
						{/if}
					</div>
				</div>
			</fieldset>
			<label class="flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={foil} /> Foil</label>
		</fieldset>
		{#if message}<p role="alert" class="text-sm text-red-400">{message}</p>{/if}
		<div class="flex flex-wrap justify-between gap-2">
			<button type="button" onclick={() => send('DELETE', {})} disabled={busy} class="btn btn-danger">Remove from deck</button>
			<button type="submit" disabled={busy} class="btn btn-primary">{busy ? 'Saving…' : 'Save'}</button>
		</div>
	</form>
</dialog>

<style>
	dialog::backdrop { background: #000a; }
</style>
