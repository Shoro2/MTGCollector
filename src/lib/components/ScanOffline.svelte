<script lang="ts">
	/**
	 * Offline mode of the scanner (CLAUDE.md §6.5): the switch that installs or
	 * removes the service worker, how much the site stores, and the notice for
	 * captures saved while offline. The queue itself is driven by the scan page.
	 */
	import { onMount } from 'svelte';
	import { dev, version } from '$app/environment';
	import { disableOffline, enableOffline, formatBytes, offlineEnabled, offlineSupported, storedBytes } from '$lib/offline/client';
	import { openCvUrl } from '$lib/scanner/assets';
	import { DETECT_WORKER_URL } from '$lib/scanner/detect';

	let { online, queued, failed = 0, processing = false, onProcess, onDiscard }: {
		online: boolean;
		/** Captures waiting in the queue (including `failed`). */
		queued: number;
		/** Captures an automatic run skips because their identification failed repeatedly. */
		failed?: number;
		processing?: boolean;
		onProcess: () => void;
		onDiscard: () => void;
	} = $props();

	let supported = $state(false);
	let enabled = $state(false);
	let busy = $state(false);
	let error = $state('');
	let stored = $state<number | null>(null);

	async function refresh() {
		enabled = await offlineEnabled();
		stored = await storedBytes();
	}

	onMount(() => {
		supported = offlineSupported();
		if (supported) void refresh();
	});

	async function turnOn() {
		busy = true;
		error = '';
		try {
			await enableOffline([openCvUrl(), `${DETECT_WORKER_URL}?v=${encodeURIComponent(version)}`], dev);
		} catch (err) {
			error = (err as Error).message || 'Offline mode could not be turned on.';
		} finally {
			await refresh();
			busy = false;
		}
	}

	async function turnOff() {
		if (queued > 0 && !confirm(`${queued} saved capture${queued === 1 ? ' is' : 's are'} still waiting. Turn offline mode off and keep them for later? They stay on this device until you identify or discard them.`)) return;
		busy = true;
		error = '';
		try {
			await disableOffline();
		} catch (err) {
			error = (err as Error).message || 'Offline mode could not be turned off.';
		} finally {
			await refresh();
			busy = false;
		}
	}
</script>

{#if !online || queued > 0}
	<div role="status" data-offline-notice data-online={online ? '1' : '0'} data-queued={queued}
		class="rounded-lg border px-3 py-2 text-sm {online ? 'border-[var(--color-border)] bg-[var(--color-surface)]' : 'border-yellow-500/30 bg-yellow-500/10 text-yellow-200'}">
		{#if !online}
			<p class="font-medium">You are offline.</p>
			<p class="text-yellow-200/80">Captures are saved on this device and identified as soon as the connection is back{queued > 0 ? ` (${queued} waiting)` : ''}.{#if !enabled && supported} Turn on offline mode below so this page also opens without a connection.{/if}</p>
		{:else}
			<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
				<p class="mr-auto">
					{#if processing}
						Identifying captures saved offline… {queued} left.
					{:else}
						{queued} capture{queued === 1 ? '' : 's'} saved offline {queued === 1 ? 'is' : 'are'} waiting{failed > 0 ? `, ${failed} could not be read` : ''}.
					{/if}
				</p>
				{#if !processing && queued > failed}
					<button type="button" class="btn btn-primary" onclick={onProcess}>Identify now</button>
				{/if}
				{#if !processing}
					<button type="button" class="btn" onclick={onDiscard}>Discard</button>
				{/if}
			</div>
		{/if}
	</div>
{/if}

{#if supported}
	<details class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3" data-offline-mode={enabled ? 'on' : 'off'}>
		<summary class="cursor-pointer font-medium">Offline mode · {enabled ? 'On' : 'Off'}</summary>
		<div class="mt-3 space-y-3 text-sm">
			<p class="text-[var(--color-text-muted)]">Scan without a connection, at a fair or in a basement. This keeps the scanner page and the card detector on this device (about 15 MB). Captures made offline are stored here and identified with the same checks as always once you are back online. Nothing is sent while offline.</p>
			{#if enabled}
				<p>Ready offline{stored !== null ? ` · ${formatBytes(stored)} stored by this site` : ''}.</p>
				<button type="button" class="btn" onclick={turnOff} disabled={busy}>{busy ? 'Working…' : 'Turn off offline mode'}</button>
			{:else}
				<button type="button" class="btn btn-primary" onclick={turnOn} disabled={busy || !online}>{busy ? 'Storing…' : 'Make available offline'}</button>
				{#if !online}<p class="text-[var(--color-text-muted)]">Needs a connection once.</p>{/if}
			{/if}
			{#if error}<p role="alert" class="text-red-400">{error}</p>{/if}
			<p class="text-xs text-[var(--color-text-muted)]">Prices, card images and adding to your collection still need a connection. <a href="/datenschutz#m-offline" class="underline hover:text-[var(--color-primary)]">What is stored</a></p>
		</div>
	</details>
{/if}
