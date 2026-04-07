<script lang="ts">
	import { onMount } from 'svelte';

	type Props = {
		/** Base64-encoded UTF-8 text. Use \n for line breaks. */
		data: string;
		/** Optional href prefix, e.g. 'tel:' — wraps the revealed text in an <a>. */
		href?: string;
		/** When true, requires a user click before decoding (extra anti-bot layer). */
		reveal?: boolean;
		/** Label for the reveal button. */
		revealLabel?: string;
	};

	let { data, href, reveal = false, revealLabel = 'Anzeigen' }: Props = $props();
	let revealed = $state<string | null>(null);
	let mounted = $state(false);

	function decode() {
		try {
			const binary = atob(data);
			const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
			revealed = new TextDecoder('utf-8').decode(bytes);
		} catch {
			revealed = '';
		}
	}

	onMount(() => {
		mounted = true;
		// Auto-decode only if reveal mode is OFF.
		if (!reveal) decode();
	});

	const lines = $derived(revealed === null ? [] : revealed.split('\n'));
</script>

{#if revealed === null}
	{#if reveal && mounted}
		<button type="button" class="reveal-btn" onclick={decode}>{revealLabel}</button>
	{:else}
		<span aria-hidden="true">…</span>
		<noscript>Bitte JavaScript aktivieren, um diese Daten anzuzeigen.</noscript>
	{/if}
{:else if href}
	<a href={`${href}${revealed.replace(/\s+/g, '')}`}>{revealed}</a>
{:else}
	{#each lines as line, i}
		{#if i > 0}<br />{/if}{line}
	{/each}
{/if}

<style>
	.reveal-btn {
		display: inline-block;
		padding: 0.35rem 0.85rem;
		border-radius: 0.375rem;
		font-size: 0.85rem;
		font-weight: 500;
		cursor: pointer;
		background: var(--color-surface);
		color: var(--color-text);
		border: 1px solid var(--color-border);
		transition: background 0.15s, border-color 0.15s;
	}
	.reveal-btn:hover {
		background: var(--color-surface-hover);
		border-color: var(--color-primary);
	}
</style>
