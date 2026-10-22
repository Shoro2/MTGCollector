<script lang="ts">
	import { onMount } from 'svelte';

	/** The deck as text: with printings (Moxfield, Archidekt, MTG Arena) or names only. */
	let { deckId, onclose }: { deckId: string; onclose: () => void } = $props();

	let dialog: HTMLDialogElement;
	let style = $state<'printings' | 'names'>('printings');
	let text = $state('');
	let loading = $state(true);
	let copied = $state(false);

	async function load() {
		loading = true;
		copied = false;
		const response = await fetch(`/decks/${deckId}/export?style=${style}`);
		text = response.ok ? await response.text() : '';
		loading = false;
	}

	onMount(() => {
		dialog.showModal();
		load();
	});

	async function copy() {
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
		} catch {
			copied = false;
		}
	}
</script>

<dialog
	bind:this={dialog}
	onclose={onclose}
	aria-labelledby="deck-export-title"
	class="w-[calc(100%-2rem)] max-w-xl max-h-[90dvh] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-[var(--color-text)]"
>
	<div class="mb-4 flex items-start justify-between gap-3">
		<h2 id="deck-export-title" class="text-xl font-semibold">Export deck</h2>
		<button type="button" onclick={() => dialog.close()} aria-label="Close" class="btn min-h-8 px-3">×</button>
	</div>
	<div class="space-y-4">
		<div class="flex gap-1 border-b border-[var(--color-border)]" role="tablist" aria-label="Export style">
			{#each [['printings', 'With printings'], ['names', 'Names only']] as [value, label] (value)}
				<button
					type="button"
					role="tab"
					aria-selected={style === value}
					onclick={() => { style = value as typeof style; load(); }}
					class="-mb-px border-b-2 px-4 py-2 text-sm font-medium {style === value ? 'border-[var(--color-primary)] text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}"
				>{label}</button>
			{/each}
		</div>
		<p class="text-xs text-[var(--color-text-muted)]">
			{style === 'printings' ? 'Each line names the set and collector number, *F* marks foils. Moxfield, Archidekt and MTG Arena import it.' : 'Card names only, for any deck builder or a printout.'}
		</p>
		<textarea readonly value={loading ? 'Loading…' : text} rows="14" aria-label="Deck list" class="control block w-full px-3 py-2 font-mono text-xs"></textarea>
		<div class="flex flex-wrap gap-2">
			<button type="button" onclick={copy} disabled={loading || !text} class="btn btn-primary">{copied ? 'Copied' : 'Copy to clipboard'}</button>
			<a href="/decks/{deckId}/export?style={style}&download=1" download class="btn">Download .txt</a>
		</div>
	</div>
</dialog>

<style>
	dialog::backdrop { background: #000a; }
</style>
