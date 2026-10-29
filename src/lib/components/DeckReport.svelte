<script lang="ts">
	import { onMount } from 'svelte';

	/** Report someone else's shared deck: a reason, once per deck. */
	let { deckId, onclose, onreported }: { deckId: string; onclose: () => void; onreported: () => Promise<void> } = $props();

	const REASONS = [
		['spam', 'Spam or advertising'],
		['offensive', 'Offensive or hateful'],
		['other', 'Something else that does not belong here']
	] as const;

	let dialog: HTMLDialogElement;
	onMount(() => dialog.showModal());
	let reason = $state<(typeof REASONS)[number][0] | ''>('');
	let busy = $state(false);
	let message = $state('');
	let done = $state(false);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		message = '';
		try {
			const response = await fetch(`/api/decks/${deckId}/report`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reason })
			});
			const result = await response.json().catch(() => ({}));
			if (!response.ok || !result.success) throw new Error(result.message || 'The report was not sent.');
			done = true;
			await onreported();
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
	aria-labelledby="deck-report-title"
	class="w-[calc(100%-2rem)] max-w-md max-h-[90dvh] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-[var(--color-text)]"
>
	<div class="mb-4 flex items-start justify-between gap-3">
		<h2 id="deck-report-title" class="text-xl font-semibold">Report this deck</h2>
		<button type="button" onclick={() => dialog.close()} disabled={busy} aria-label="Close" class="btn min-h-8 px-3">×</button>
	</div>
	{#if done}
		<p role="status" class="text-sm">Thank you. Your report is saved.</p>
		<button type="button" onclick={() => dialog.close()} class="btn btn-primary mt-4">Done</button>
	{:else}
		<form onsubmit={submit} class="space-y-4">
			<fieldset disabled={busy} class="space-y-2">
				<legend class="text-sm text-[var(--color-text-muted)]">What is wrong with its name or description?</legend>
				{#each REASONS as [value, label] (value)}
					<label class="flex items-center gap-2 text-sm"><input type="radio" name="report-reason" {value} bind:group={reason} /> {label}</label>
				{/each}
			</fieldset>
			<p class="text-xs text-[var(--color-text-muted)]">
				When several players report a deck, its description and author name are hidden and it leaves the public deck list. Your report is stored with your account and never shown to the deck's owner.
			</p>
			{#if message}<p role="alert" class="text-sm text-red-400">{message}</p>{/if}
			<div class="flex justify-end">
				<button type="submit" disabled={busy || !reason} class="btn btn-primary">{busy ? 'Sending…' : 'Send report'}</button>
			</div>
		</form>
	{/if}
</dialog>

<style>
	dialog::backdrop { background: #000a; }
</style>
