<script lang="ts">
	import { CONDITIONS, type CollectionChanges } from '$lib/collection-fields';
	import { LANGUAGES } from '$lib/utils';
	let { ids, locations, ondone }: { ids: number[]; locations: string[]; ondone: () => Promise<void> } = $props();
	let locationEnabled = $state(false);
	let location = $state('');
	let condition = $state('');
	let language = $state('');
	let finish = $state('');
	let busy = $state(false);
	let message = $state('');
	async function save() {
		busy = true; message = '';
		const changes: CollectionChanges = {};
		if (locationEnabled) changes.location = location;
		if (condition) changes.condition = condition;
		if (language) changes.language = language;
		if (finish) changes.foil = finish === 'foil';
		try {
			const res = await fetch('/collection/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'edit', ids, changes }) });
			const result = await res.json();
			if (!res.ok) throw new Error(result.message || 'Could not save changes.');
			await ondone();
		} catch (error) { message = (error as Error).message; }
		finally { busy = false; }
	}
</script>

<details class="rounded-lg border border-[var(--color-border)] p-3 bg-[var(--color-surface)]" open>
	<summary class="cursor-pointer font-medium">Edit {ids.length} selected entries</summary>
	<fieldset disabled={busy} class="mt-3 space-y-3">
		<p class="text-xs text-[var(--color-text-muted)]">Changes apply to every copy in the selected entries. Unchanged fields and purchase costs are kept.</p>
		<label class="flex gap-2 items-center"><input type="checkbox" bind:checked={locationEnabled} />Change location (empty clears it)</label>
		{#if locationEnabled}
			<input aria-label="New location" bind:value={location} list="bulk-locations" maxlength="120" placeholder="Box A / Blue" class="w-full rounded border p-2 bg-[var(--color-bg)]" />
			<datalist id="bulk-locations">{#each locations as value}<option value={value}></option>{/each}</datalist>
		{/if}
		<div class="grid sm:grid-cols-3 gap-2">
			<label>Condition<select bind:value={condition} class="block w-full rounded border p-2 bg-[var(--color-bg)]"><option value="">Keep condition</option>{#each CONDITIONS as c}<option value={c.value}>{c.label}</option>{/each}</select></label>
			<label>Language<select bind:value={language} class="block w-full rounded border p-2 bg-[var(--color-bg)]"><option value="">Keep language</option>{#each LANGUAGES as l}<option value={l.code}>{l.label}</option>{/each}</select></label>
			<label>Finish<select bind:value={finish} class="block w-full rounded border p-2 bg-[var(--color-bg)]"><option value="">Keep finish</option><option value="foil">Foil</option><option value="nonfoil">Non-Foil</option></select></label>
		</div>
		<button onclick={save} disabled={!locationEnabled && !condition && !language && !finish} class="rounded bg-[var(--color-primary-button)] px-4 py-2 disabled:opacity-50">{busy ? 'Saving…' : 'Apply to selected entries'}</button>
	</fieldset>
	{#if message}<p role="alert" class="mt-2 text-red-400">{message}</p>{/if}
</details>
