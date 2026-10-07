<script lang="ts">
	let { id, quantity, locations, ondone }: { id: number; quantity: number; locations: string[]; ondone: () => Promise<void> } = $props();
	let count = $state(1);
	let location = $state('');
	let busy = $state(false);
	let message = $state('');
	async function move() {
		busy = true; message = '';
		try {
			const response = await fetch('/collection/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'move', id, quantity: count, location }) });
			const result = await response.json();
			if (!response.ok) throw new Error(result.message || 'Move failed.');
			await ondone();
		} catch (error) { message = (error as Error).message; }
		finally { busy = false; }
	}
</script>
<details class="rounded border border-[var(--color-border)] p-3">
	<summary class="cursor-pointer">Move some copies to another location</summary>
	<fieldset disabled={busy} class="space-y-2 mt-3">
		<p class="text-xs text-[var(--color-text-muted)]">Moves the saved entry's copies. Save other edits first. Purchase cost, date and tags are kept.</p>
		<label class="block">Copies<input type="number" bind:value={count} min="1" max={quantity} step="1" class="block w-full rounded border p-2 bg-[var(--color-bg)]" /></label>
		<label class="block">Destination<input bind:value={location} maxlength="120" list="move-locations" placeholder="Box B / Red" class="block w-full rounded border p-2 bg-[var(--color-bg)]" /></label>
		<datalist id="move-locations">{#each locations as value}<option value={value}></option>{/each}</datalist>
		<button onclick={move} class="rounded border px-3 py-2">{busy ? 'Moving…' : 'Move copies'}</button>
	</fieldset>
	{#if message}<p role="alert" class="text-red-400">{message}</p>{/if}
</details>
