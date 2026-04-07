<script lang="ts">
	import { onMount } from 'svelte';

	type Props = {
		/** Base64-encoded UTF-8 text. Use \n for line breaks. */
		data: string;
		/** Optional href prefix, e.g. 'tel:' — wraps the revealed text in an <a>. */
		href?: string;
	};

	let { data, href }: Props = $props();
	let revealed = $state<string | null>(null);

	onMount(() => {
		try {
			// Decode base64 → UTF-8 (handles non-ASCII like ß)
			const binary = atob(data);
			const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
			revealed = new TextDecoder('utf-8').decode(bytes);
		} catch {
			revealed = '';
		}
	});

	const lines = $derived(revealed === null ? [] : revealed.split('\n'));
</script>

{#if revealed === null}
	<span aria-hidden="true">…</span>
	<noscript>Bitte JavaScript aktivieren, um diese Kontaktdaten anzuzeigen.</noscript>
{:else if href}
	<a href={`${href}${revealed.replace(/\s+/g, '')}`}>{revealed}</a>
{:else}
	{#each lines as line, i}
		{#if i > 0}<br />{/if}{line}
	{/each}
{/if}
