<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { DECK_FORMATS } from '$lib/deck-formats';
	import { INDEX_MIN_CARDS } from '$lib/deck-seo';
	import { VISIBILITIES, VISIBILITY_LABELS, type Bracket, type Visibility } from '$lib/deck';
	import BracketSelect from './BracketSelect.svelte';
	import Turnstile from './Turnstile.svelte';

	type Deck = { id: string; name: string; format: string; visibility: Visibility; description: string; bracket: Bracket | null; author_name: string };
	/**
	 * Name, format, visibility, bracket, author name and description of a deck, and deleting
	 * it. Making the deck public needs the captcha (`captchaSiteKey`, null when it is off) and
	 * is refused up front with `publishBlocked`, the limit's message, after three public decks
	 * within 24 hours.
	 */
	let { deck, hint = '', captchaSiteKey = null, publishBlocked = null, onclose, onsaved }: {
		deck: Deck; hint?: string; captchaSiteKey?: string | null; publishBlocked?: string | null; onclose: () => void; onsaved: () => Promise<void>;
	} = $props();

	let dialog: HTMLDialogElement;
	let name = $state('');
	let format = $state('commander');
	let visibility = $state<Visibility>('private');
	let description = $state('');
	let bracket = $state<Bracket | null>(null);
	let author = $state('');
	let captcha = $state<ReturnType<typeof Turnstile>>();
	let captchaToken = $state('');
	const limitReached = $derived(visibility === 'public' && deck.visibility !== 'public' && !!publishBlocked);
	const needsCaptcha = $derived(visibility === 'public' && deck.visibility !== 'public' && !limitReached && !!captchaSiteKey);
	// Brackets belong to the commander formats; another format keeps the stored value untouched.
	const commanderFormat = $derived(DECK_FORMATS.find((f) => f.key === format)?.kind === 'commander');
	let confirmDelete = $state(false);
	let busy = $state(false);
	let message = $state('');

	onMount(() => {
		({ name, format, visibility, description, bracket } = deck);
		author = deck.author_name;
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
			// A Turnstile token is good for one check, even when the change was refused for another reason.
			if (needsCaptcha) captcha?.reset();
			return false;
		} finally {
			busy = false;
		}
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		const body = { name, format, visibility, description, author_name: author, ...(commanderFormat ? { bracket } : {}) };
		if (await request('PATCH', needsCaptcha ? { ...body, captcha: captchaToken } : body)) {
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
					Private decks are yours alone. Unlisted and public decks can be viewed by anyone with the link, with the author name below but never your Google name, e-mail address or collection. Public decks are listed for everybody, and from {INDEX_MIN_CARDS} cards on search engines such as Google may show them.
				</p>
			</fieldset>
			<label class="block text-sm">
				<span class="text-[var(--color-text-muted)]">Author name (optional)</span>
				<input bind:value={author} maxlength="40" autocomplete="nickname" placeholder="Shown as “by …” when you share the deck" class="control mt-1 block w-full px-3 text-sm" data-author-input />
			</label>
			<label class="block text-sm">
				<span class="text-[var(--color-text-muted)]">Description</span>
				<textarea bind:value={description} rows="4" maxlength="5000" class="control mt-1 block w-full px-3 py-2 text-sm"></textarea>
			</label>
		</fieldset>
		{#if limitReached}
			<p role="alert" class="text-sm text-amber-300" data-publish-limit>{publishBlocked}</p>
		{:else if needsCaptcha && captchaSiteKey}
			<div data-deck-captcha>
				<p class="mb-1 text-xs text-[var(--color-text-muted)]">A public deck is listed for everybody, so we check that you are human first.</p>
				<Turnstile bind:this={captcha} bind:token={captchaToken} siteKey={captchaSiteKey} action="publish-deck" />
			</div>
		{/if}
		{#if message}<p role="alert" class="text-sm text-red-400">{message}</p>{/if}
		<div class="flex justify-end">
			<button type="submit" disabled={busy || !name.trim() || limitReached || (needsCaptcha && !captchaToken)} class="btn btn-primary">{busy ? 'Saving…' : 'Save'}</button>
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
