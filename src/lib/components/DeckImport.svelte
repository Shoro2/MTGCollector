<script lang="ts">
	import { onMount } from 'svelte';
	import DeckLineIssues from './DeckLineIssues.svelte';

	/** Paste or upload a list into an existing deck: add the cards or replace the deck. */
	let { deckId, onclose, onimported }: { deckId: string; onclose: () => void; onimported: () => Promise<void> } = $props();

	let dialog: HTMLDialogElement;
	onMount(() => dialog.showModal());
	let text = $state('');
	let mode = $state<'add' | 'replace'>('add');
	let confirmReplace = $state(false);
	let busy = $state(false);
	let message = $state('');
	type Line = { line: number; text: string; message: string };
	let result = $state<{ added: number; issues: Line[]; notes: Line[] } | null>(null);

	async function readFile(event: Event) {
		const file = (event.target as HTMLInputElement).files?.[0];
		if (!file) return;
		if (file.size > 200_000) message = 'The file is too large (at most 200 KB of text).';
		else text = await file.text();
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		message = '';
		try {
			const response = await fetch(`/api/decks/${deckId}/import`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text, mode })
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok || !data.success) throw new Error(data.message || 'The import failed.');
			result = data;
			await onimported();
		} catch (error) {
			message = (error as Error).message;
		} finally {
			busy = false;
		}
	}
</script>

<dialog
	bind:this={dialog}
	onclose={onclose}
	oncancel={(e) => { if (busy) e.preventDefault(); }}
	aria-labelledby="deck-import-title"
	class="w-[calc(100%-2rem)] max-w-xl max-h-[90dvh] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-[var(--color-text)]"
>
	<div class="mb-4 flex items-start justify-between gap-3">
		<h2 id="deck-import-title" class="text-xl font-semibold">Import cards</h2>
		<button type="button" onclick={() => dialog.close()} disabled={busy} aria-label="Close" class="btn min-h-8 px-3">×</button>
	</div>
	{#if result}
		<div class="space-y-4">
			<p role="status" class="text-green-400">Imported {result.added} cards.</p>
			<DeckLineIssues issues={result.issues} notes={result.notes} />
			<button type="button" onclick={() => dialog.close()} class="btn btn-primary">Done</button>
		</div>
	{:else}
		<form onsubmit={submit} class="space-y-4">
			<fieldset disabled={busy} class="space-y-4">
				<label class="block text-sm">
					<span class="text-[var(--color-text-muted)]">Card list</span>
					<textarea bind:value={text} rows="10" placeholder={'1 Sol Ring (C21) 263\n4 Lightning Bolt\n\nSideboard\n2 Pyroblast'} class="control mt-1 block w-full px-3 py-2 font-mono text-xs"></textarea>
				</label>
				<label class="block text-sm">
					<span class="text-[var(--color-text-muted)]">Or read a file</span>
					<input type="file" accept=".txt,.dec,text/plain" onchange={readFile} class="mt-1 block w-full text-sm" />
				</label>
				<p class="text-xs text-[var(--color-text-muted)]">
					Moxfield, MTG Arena, MTGO and Archidekt text lists. Sections such as Commander, Sideboard and Maybeboard decide the board; everything else goes to the main deck.
				</p>
				<fieldset>
					<legend class="text-sm text-[var(--color-text-muted)]">Mode</legend>
					<label class="mt-1 flex items-center gap-2 text-sm"><input type="radio" name="import-mode" value="add" bind:group={mode} /> Add to the deck</label>
					<label class="mt-1 flex items-center gap-2 text-sm"><input type="radio" name="import-mode" value="replace" bind:group={mode} /> Replace every card in the deck</label>
				</fieldset>
				{#if mode === 'replace'}
					<label class="flex items-start gap-2 text-sm text-red-300">
						<input type="checkbox" bind:checked={confirmReplace} class="mt-1" /> Remove the current cards and import this list instead.
					</label>
				{/if}
			</fieldset>
			{#if message}<p role="alert" class="text-sm text-red-400">{message}</p>{/if}
			<div class="flex justify-end">
				<button type="submit" disabled={busy || !text.trim() || (mode === 'replace' && !confirmReplace)} class="btn btn-primary">{busy ? 'Importing…' : 'Import'}</button>
			</div>
		</form>
	{/if}
</dialog>

<style>
	dialog::backdrop { background: #000a; }
</style>
