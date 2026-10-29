<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { DECK_FORMATS, deckFormat } from '$lib/deck-formats';
	import { INDEX_MIN_CARDS } from '$lib/deck-seo';
	import { VISIBILITIES, VISIBILITY_LABELS, type Bracket, type CardSuggestion, type Visibility } from '$lib/deck';
	import CardSearchInput from './CardSearchInput.svelte';
	import BracketSelect from './BracketSelect.svelte';
	import DeckLineIssues from './DeckLineIssues.svelte';
	import Turnstile from './Turnstile.svelte';
	import { deckLinkHelp } from '$lib/deck-text';

	/**
	 * `authorName` prefills the author field with the name the user chose last;
	 * `captchaSiteKey` (null when the captcha is off) shows the check a public deck needs;
	 * `publishBlocked` is the limit's message once the user has made three decks public
	 * within 24 hours (the server refuses a fourth either way).
	 */
	let { onclose, authorName = '', captchaSiteKey = null, publishBlocked = null }: {
		onclose: () => void; authorName?: string; captchaSiteKey?: string | null; publishBlocked?: string | null;
	} = $props();
	let dialog: HTMLDialogElement;
	onMount(() => {
		author = authorName;
		dialog.showModal();
	});

	let name = $state('');
	let format = $state('commander');
	let commander = $state<CardSuggestion | null>(null);
	let partner = $state<CardSuggestion | null>(null);
	let bracket = $state<Bracket | null>(null);
	let legalOnly = $state(true);
	let visibility = $state<Visibility>('private');
	let author = $state('');
	let captcha = $state<ReturnType<typeof Turnstile>>();
	let captchaToken = $state('');
	const limitReached = $derived(visibility === 'public' && !!publishBlocked);
	const needsCaptcha = $derived(visibility === 'public' && !limitReached && !!captchaSiteKey);
	let source = $state<'none' | 'paste' | 'file'>('none');
	let text = $state('');
	// A pasted deck link gets an explanation of where the site's text export is.
	const linkHelp = $derived(source === 'paste' ? deckLinkHelp(text) : null);
	let fileText = $state('');
	let busy = $state(false);
	let message = $state('');
	type Line = { line: number; text: string; message: string };
	let created = $state<{ id: string; added: number; issues: Line[]; notes: Line[] } | null>(null);

	const selected = $derived(deckFormat(format));
	const leader = $derived(selected.command === 'oathbreaker' ? 'Oathbreaker' : 'Commander');
	// A second commander: Partner, Friends forever, a Background or a Doctor's companion.
	const canTakePartner = $derived(!!commander?.partner && !!selected.command && selected.command !== 'oathbreaker');
	$effect(() => {
		if (!canTakePartner) partner = null;
	});
	const VISIBILITY_HELP: Record<Visibility, string> = {
		private: 'Only you can see it.',
		unlisted: 'Anyone with the link can view it. It is never listed, and search engines do not show it.',
		public: `Anyone with the link can view it, it is listed in the public deck list, and from ${INDEX_MIN_CARDS} cards on search engines such as Google may show it.`
	};

	async function readFile(event: Event) {
		const file = (event.target as HTMLInputElement).files?.[0];
		message = '';
		if (!file) return void (fileText = '');
		if (file.size > 200_000) {
			message = 'The file is too large (at most 200 KB of text).';
			fileText = '';
			return;
		}
		fileText = await file.text();
	}

	async function create(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		message = '';
		const list = source === 'paste' ? text : source === 'file' ? fileText : '';
		try {
			const response = await fetch('/api/decks', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name, format, visibility, list, author_name: author,
					captcha: needsCaptcha ? captchaToken : undefined,
					commanderId: selected.command ? commander?.id : undefined,
					partnerId: canTakePartner ? partner?.id : undefined,
					bracket: selected.kind === 'commander' ? bracket : null
				})
			});
			const result = await response.json().catch(() => ({}));
			if (!response.ok || !result.success) throw new Error(result.message || 'The deck could not be created.');
			if (result.issues.length || result.notes.length) created = result;
			else await goto(`/decks/${result.id}`);
		} catch (error) {
			message = (error as Error).message;
			// A Turnstile token is good for one check, even when the deck was refused for another reason.
			if (needsCaptcha) captcha?.reset();
		} finally {
			busy = false;
		}
	}
</script>

<dialog
	bind:this={dialog}
	onclose={onclose}
	oncancel={(e) => { if (busy) e.preventDefault(); }}
	aria-labelledby="create-deck-title"
	class="w-[calc(100%-2rem)] max-w-xl max-h-[90dvh] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-[var(--color-text)]"
>
	<div class="mb-4 flex items-start justify-between gap-3">
		<h2 id="create-deck-title" class="text-xl font-semibold">Create new deck</h2>
		<button type="button" onclick={() => dialog.close()} disabled={busy} aria-label="Close" class="btn min-h-8 px-3">×</button>
	</div>
	{#if created}
		<div class="space-y-4">
			<p role="status" class="text-green-400">The deck was created with {created.added} cards.</p>
			<DeckLineIssues issues={created.issues} notes={created.notes} />
			<a href="/decks/{created.id}" class="btn btn-primary">Open deck</a>
		</div>
	{:else}
		<form onsubmit={create} class="space-y-4">
			<fieldset disabled={busy} class="space-y-4">
				<label class="block text-sm">
					<span class="text-[var(--color-text-muted)]">Name</span>
					<!-- svelte-ignore a11y_autofocus -->
					<input bind:value={name} required maxlength="100" autofocus class="control mt-1 block w-full px-3 text-sm" />
				</label>
				<div class="grid gap-4 sm:grid-cols-2">
					<label class="block text-sm">
						<span class="text-[var(--color-text-muted)]">Format</span>
						<select bind:value={format} class="control mt-1 block w-full px-2 text-sm">
							{#each DECK_FORMATS as f (f.key)}<option value={f.key}>{f.label}</option>{/each}
						</select>
					</label>
					{#if selected.command}
						<div>
							{#if commander}
								<p class="text-sm text-[var(--color-text-muted)]">{leader}</p>
								<p class="mt-1 flex min-h-[var(--control-height)] items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 text-sm">
									<span class="min-w-0 flex-1 truncate">{commander.name}</span>
									<button type="button" onclick={() => (commander = null)} class="text-[var(--color-text-muted)] hover:text-[var(--color-text)]" aria-label="Remove {commander.name}">×</button>
								</p>
							{:else}
								<CardSearchInput label={leader} placeholder="Who leads the deck?" {format} commander legal={legalOnly} onselect={(card) => (commander = card)} />
							{/if}
							<label class="mt-1 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
								<input type="checkbox" bind:checked={legalOnly} /> Search only legal cards
							</label>
						</div>
					{/if}
					{#if canTakePartner && commander}
						<div class="sm:col-start-2" data-partner-field>
							{#if partner}
								<p class="text-sm text-[var(--color-text-muted)]">Partner</p>
								<p class="mt-1 flex min-h-[var(--control-height)] items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 text-sm">
									<span class="min-w-0 flex-1 truncate">{partner.name}</span>
									<button type="button" onclick={() => (partner = null)} class="text-[var(--color-text-muted)] hover:text-[var(--color-text)]" aria-label="Remove {partner.name}">×</button>
								</p>
							{:else}
								<CardSearchInput label="Partner (optional)" placeholder="Second commander…" {format} legal={legalOnly} partnerOf={commander.id} onselect={(card) => (partner = card)} />
								<p class="mt-1 text-xs text-[var(--color-text-muted)]">Only cards that may share the command zone with {commander.name}.</p>
							{/if}
						</div>
					{/if}
					{#if selected.kind === 'commander'}
						<BracketSelect bind:value={bracket} />
					{/if}
				</div>
				<fieldset>
					<legend class="text-sm text-[var(--color-text-muted)]">Visibility</legend>
					<div class="mt-1 flex flex-wrap gap-2">
						{#each VISIBILITIES as v (v)}
							<label class="chip cursor-pointer {visibility === v ? 'border-[var(--color-primary)] text-[var(--color-text)]' : ''}">
								<input type="radio" name="visibility" value={v} bind:group={visibility} /> {VISIBILITY_LABELS[v]}
							</label>
						{/each}
					</div>
					<p class="mt-1 text-xs text-[var(--color-text-muted)]">{VISIBILITY_HELP[visibility]} Your Google name, e-mail address and collection are never shown.</p>
				</fieldset>
				<label class="block text-sm">
					<span class="text-[var(--color-text-muted)]">Author name (optional)</span>
					<input bind:value={author} maxlength="40" autocomplete="nickname" placeholder="Shown as “by …” when you share the deck" class="control mt-1 block w-full px-3 text-sm" data-author-input />
				</label>
				<fieldset>
					<legend class="text-sm text-[var(--color-text-muted)]">Existing deck list (optional)</legend>
					<div class="mt-1 flex flex-wrap gap-2">
						{#each [['none', 'None'], ['paste', 'Paste in list'], ['file', 'From file']] as [value, text] (value)}
							<label class="chip cursor-pointer {source === value ? 'border-[var(--color-primary)] text-[var(--color-text)]' : ''}">
								<input type="radio" name="source" {value} bind:group={source} /> {text}
							</label>
						{/each}
					</div>
					{#if source === 'paste'}
						<label class="mt-2 block text-sm">
							<span class="sr-only">Card list</span>
							<textarea bind:value={text} rows="8" placeholder={'1 Sol Ring (C21) 263\n4 Lightning Bolt\n\nSideboard\n2 Pyroblast'} class="control block w-full px-3 py-2 font-mono text-xs"></textarea>
						</label>
						{#if linkHelp}<p class="mt-2 rounded-lg border border-[var(--color-accent-muted)] p-3 text-sm" role="status" data-link-help>{linkHelp}</p>{/if}
					{:else if source === 'file'}
						<label class="mt-2 block text-sm">
							<span class="sr-only">Deck file</span>
							<input type="file" accept=".txt,.dec,text/plain" onchange={readFile} class="block w-full text-sm" />
						</label>
					{/if}
					{#if source !== 'none'}
						<p class="mt-1 text-xs text-[var(--color-text-muted)]">
							Moxfield, MTG Arena, MTGO and Archidekt text lists: one card per line ("1 Sol Ring" or "1 Sol Ring (C21) 263", *F* for foil), sections such as Commander, Sideboard and Maybeboard. Without a set the newest regular printing is used.
						</p>
					{/if}
				</fieldset>
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
				<button type="submit" disabled={busy || !name.trim() || !!linkHelp || limitReached || (needsCaptcha && !captchaToken)} class="btn btn-primary">{busy ? 'Creating…' : 'Create'}</button>
			</div>
		</form>
	{/if}
</dialog>

<style>
	dialog::backdrop { background: #000a; }
</style>
