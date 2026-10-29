<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { DECK_FORMATS } from '$lib/deck-formats';
	import { VISIBILITIES, VISIBILITY_LABELS, type Bracket, type Visibility } from '$lib/deck';
	import BracketSelect from './BracketSelect.svelte';

	type Deck = { id: string; name: string; format: string; visibility: Visibility; description: string; bracket: Bracket | null };
	/** Name, format, visibility, bracket and description of a deck, and deleting it. */
	let { deck, hint = '', onclose, onsaved }: { deck: Deck; hint?: string; onclose: () => void; onsaved: () => Promise<void> } = $props();

	let dialog: HTMLDialogElement;
	let name = $state('');
	let format = $state('commander');
	let visibility = $state<Visibility>('private');
	let description = $state('');
	let bracket = $state<Bracket | null>(null);
	// Brackets belong to the commander formats; another format keeps the stored value untouched.
	const commanderFormat = $derived(DECK_FORMATS.find((f) => f.key === format)?.kind === 'commander');
	let confirmDelete = $state(false);
	let busy = $state(false);
	let message = $state('');

	onMount(() => {
		({ name, format, visibility, description, bracket } = deck);
		dialog.showModal();
	});

	async function request(method: 'PATCH' | 'DELETE', body?: Record<string, unknown>) {
		busy = true;
		message = '';
		try {
			const response = await fetch(`/api/decks/${deck.id}`, {
				method,
				headers: { 'Content-Type': 'application/json' },
				body: body ? JSON.stringify(body) : undefined
			});
			const result = await response.json().catch(() => ({}));
			if (!response.ok || !result.success) throw new Error(result.message || 'The change was not saved.');
			return true;
		} catch (error) {
			message = (error as Error).message;
			return false;
		} finally {
			busy = false;
		}
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (await request('PATCH', { name, format, visibility, description, ...(commanderFormat ? { bracket } : {}) })) {
			await onsaved();
			dialog.close();
		}
	}

	async function remove() {
		if (await request('DELETE')) {
			dialog.close();
			await goto('/decks', { invalidateAll: true });
		}
	}
</script>

<dialog
	bind:this={dialog}
	onclose={onclose}
	oncancel={(e) => { if (busy) e.preventDefault(); }}
	aria-labelledby="deck-settings-title"
	class="w-[calc(100%-2rem)] max-w-lg max-h-[90dvh] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-[var(--color-text)]"
>
	<div class="mb-4 flex items-start justify-between gap-3">
		<h2 id="deck-settings-title" class="text-xl font-semibold">Deck settings</h2>
		<button type="button" onclick={() => dialog.close()} disabled={busy} aria-label="Close" class="btn min-h-8 px-3">×</button>
	</div>
	{#if hint}<p class="mb-4 rounded-lg border border-[var(--color-border)] p-3 text-sm">{hint}</p>{/if}
	<form onsubmit={save} class="space-y-4">
		<fieldset disabled={busy} class="space-y-4">
			<label class="block text-sm">
				<span class="text-[var(--color-text-muted)]">Name</span>
				<input bind:value={name} required maxlength="100" class="control mt-1 block w-full px-3 text-sm" />
			</label>
			<label class="block text-sm">
				<span class="text-[var(--color-text-muted)]">Format</span>
				<select bind:value={format} class="control mt-1 block w-full px-2 text-sm">
					{#each DECK_FORMATS as f (f.key)}<option value={f.key}>{f.label}</option>{/each}
				</select>
			</label>
			{#if commanderFormat}<BracketSelect bind:value={bracket} />{/if}
			<fieldset>
				<legend class="text-sm text-[var(--color-text-muted)]">Visibility</legend>
				<div class="mt-1 flex flex-wrap gap-2">
					{#each VISIBILITIES as v (v)}
						<label class="chip cursor-pointer {visibility === v ? 'border-[var(--color-primary)] text-[var(--color-text)]' : ''}">
							<input type="radio" name="settings-visibility" value={v} bind:group={visibility} /> {VISIBILITY_LABELS[v]}
						</label>
					{/each}
				</div>
				<p class="mt-1 text-xs text-[var(--color-text-muted)]">
					Private decks are yours alone. Unlisted and public decks can be viewed by anyone with the link, without your name or collection.
				</p>
			</fieldset>
			<label class="block text-sm">
				<span class="text-[var(--color-text-muted)]">Description</span>
				<textarea bind:value={description} rows="4" maxlength="5000" class="control mt-1 block w-full px-3 py-2 text-sm"></textarea>
			</label>
		</fieldset>
		{#if message}<p role="alert" class="text-sm text-red-400">{message}</p>{/if}
		<div class="flex justify-end">
			<button type="submit" disabled={busy || !name.trim()} class="btn btn-primary">{busy ? 'Saving…' : 'Save'}</button>
		</div>
	</form>
	<div class="mt-6 border-t border-[var(--color-border)] pt-4">
		<label class="flex items-start gap-2 text-sm text-red-300">
			<input type="checkbox" bind:checked={confirmDelete} class="mt-1" /> Delete this deck and its card list. Your collection is not touched.
		</label>
		<button type="button" onclick={remove} disabled={busy || !confirmDelete} class="btn btn-danger mt-2">Delete deck</button>
	</div>
</dialog>

<style>
	dialog::backdrop { background: #000a; }
</style>
