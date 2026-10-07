<script lang="ts">
	import { onMount } from 'svelte';
	import { IMPORT_FIELDS, type ImportMapping, type ImportIssue } from '$lib/collection-import';
	let { locations, onclose, onimport }: { locations: string[]; onclose: () => void; onimport: () => Promise<void> } = $props();
	let dialog: HTMLDialogElement;
	onMount(() => dialog.showModal());
	let format = $state('csv');
	let file = $state<File | null>(null);
	let text = $state('');
	let mode = $state('merge');
	let currency = $state('EUR');
	let location = $state('');
	let ignorePrices = $state(false);
	let headers = $state<string[]>([]);
	let mapping = $state<ImportMapping>({});
	let busy = $state(false);
	let message = $state('');
	let done = $state(false);
	let confirmReplace = $state(false);
	type Preview = {
		digest: string;
		summary: { total: number; ready: number; copies: number; duplicates: number; skipped: number; issues: number; existingEntries: number; existingCopies: number };
		rows: { line: number; name: string; set: string; number: string; quantity: number; foil: number; language: string; condition: string; purchasePrice: number | null; location: string; duplicate: boolean }[];
		issues: ImportIssue[];
	};
	let preview = $state<Preview | null>(null);
	function changed() { preview = null; confirmReplace = false; done = false; message = ''; }
	function newFile(event: Event) {
		file = (event.target as HTMLInputElement).files?.[0] ?? null;
		headers = []; mapping = {}; changed();
	}
	async function send(action: 'preview' | 'commit') {
		busy = true; message = '';
		const form = new FormData();
		form.set('action', action); form.set('format', format); form.set('mode', mode);
		form.set('currency', currency); form.set('location', location); form.set('ignorePrices', String(ignorePrices));
		if (file && format === 'csv') form.set('file', file); else form.set('text', text);
		if (headers.length && format === 'csv') form.set('mapping', JSON.stringify(mapping));
		if (action === 'commit' && preview) { form.set('digest', preview.digest); form.set('confirmReplace', String(confirmReplace)); }
		try {
			const response = await fetch('/collection/import', { method: 'POST', body: form });
			if (response.status === 413) throw new Error('The file exceeds the server upload limit. Split the collection into smaller files.');
			const result = await response.json();
			if (!response.ok || !result.success) throw new Error(result.message || 'Import failed.');
			if (action === 'preview') {
				headers = result.headers; mapping = result.mapping; preview = result; confirmReplace = false;
			} else {
				preview = null; done = true;
				message = `Imported ${result.copies} copies in ${result.imported} entries. ${result.skipped} duplicate entries skipped; ${result.issues} unresolved rows left out.`;
				await onimport();
			}
		} catch (error) { message = (error as Error).message; if (action === 'commit') preview = null; }
		finally { busy = false; }
	}
</script>

<dialog bind:this={dialog} onclose={onclose} oncancel={e => { if (busy) e.preventDefault(); }} class="w-[calc(100%-2rem)] max-w-4xl max-h-[90dvh] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-[var(--color-text)]">
	<div class="flex justify-between gap-3 items-start mb-4"><h2 class="text-xl font-semibold">Import collection</h2><button onclick={onclose} disabled={busy} aria-label="Close import" class="rounded border px-3 py-1">×</button></div>
	<fieldset disabled={busy} class="space-y-4">
		<p class="text-sm text-[var(--color-text-muted)]">Import CSV exports from ManaBox, Dragon Shield, Delver Lens, Moxfield or MTG Collector. Columns are detected by their names; review or adjust them below. Delver: include the set code and collector number in your export.</p>
		<label class="block">File format<select aria-label="File format" bind:value={format} onchange={() => { headers = []; mapping = {}; changed(); }} class="block w-full rounded border p-2 bg-[var(--color-bg)]"><option value="csv">Collection CSV</option><option value="text">Moxfield text list</option></select></label>
		{#if format === 'csv'}
			<label class="block">CSV file<input type="file" accept=".csv,text/csv" onchange={newFile} class="block w-full mt-1" /></label>
		{:else}
			<label class="block">Card list<textarea bind:value={text} oninput={changed} rows="5" placeholder="1 Sol Ring (CMM) 396" class="block w-full rounded border p-2 bg-[var(--color-bg)]"></textarea></label>
		{/if}
		<div class="grid gap-3 sm:grid-cols-2">
			<label>Import mode<select aria-label="Import mode" bind:value={mode} onchange={changed} class="block w-full rounded border p-2 bg-[var(--color-bg)]"><option value="merge">Skip existing entries</option><option value="append">Add every matched entry</option><option value="sync">Replace entire collection</option></select></label>
			<label>Location for rows without a folder<input bind:value={location} oninput={changed} maxlength="120" list="import-locations" placeholder="Unassigned" class="block w-full rounded border p-2 bg-[var(--color-bg)]" /></label>
			<label>Currency when not specified<select aria-label="Currency when not specified" bind:value={currency} onchange={changed} class="block w-full rounded border p-2 bg-[var(--color-bg)]"><option value="EUR">EUR</option><option value="unknown">Unknown — flag prices for review</option></select></label>
			<label class="flex items-center gap-2"><input type="checkbox" bind:checked={ignorePrices} onchange={changed} />Ignore purchase prices</label>
		</div>
		<datalist id="import-locations">{#each locations as value}<option value={value}></option>{/each}</datalist>
		<p class="text-xs text-[var(--color-text-muted)]">A duplicate has the same printing, finish, condition, language, location and purchase price as an existing entry. Skipping it does not increase its quantity. Missing quantity defaults to 1, language to English, condition to Near Mint and finish to Non-Foil. Missing costs stay empty. Only EUR costs are imported; other currencies are flagged. Etched finishes require review.</p>
		{#if headers.length && format === 'csv'}
			<details class="rounded border p-3"><summary class="cursor-pointer">Review column mapping</summary>
				<div class="grid gap-2 mt-3 sm:grid-cols-2">{#each IMPORT_FIELDS as [key, label]}
					<label class="text-sm">{label}<select bind:value={mapping[key]} onchange={changed} class="block w-full rounded border p-2 bg-[var(--color-bg)]"><option value="">Not supplied</option>{#each headers as header}<option value={header}>{header}</option>{/each}</select></label>
				{/each}</div>
				<p class="mt-2 text-xs">Unmapped columns are not imported. Use an ISO date (YYYY-MM-DD) or leave Date added unmapped. Prices must be amounts per copy.</p>
			</details>
		{/if}
		<button onclick={() => send('preview')} disabled={done || (format === 'csv' ? !file : !text.trim())} class="rounded border px-4 py-2 disabled:opacity-50">{busy ? 'Working…' : 'Preview import'}</button>
		{#if preview}
			<section class="space-y-3" aria-label="Import preview">
				<p class="font-semibold">{preview.summary.ready} entries ready · {preview.summary.copies} copies · {preview.summary.issues} unresolved rows</p>
				<p class="text-sm">{preview.summary.duplicates} entries already exist; {preview.summary.skipped} will be skipped.</p>
				{#if preview.summary.issues}
					<div class="rounded border border-amber-500/50 p-3"><p>Unresolved rows will be left out. Replacement is disabled until all rows are resolved.</p>
						<ul class="mt-2 text-sm space-y-1">{#each preview.issues as issue}<li>Row {issue.line}: {issue.name} — {issue.message}</li>{/each}</ul>
						{#if preview.summary.issues > preview.issues.length}<p>Showing the first {preview.issues.length} issues. Fix these and preview again.</p>{/if}
					</div>
				{/if}
				<details open><summary class="cursor-pointer">Matched entries (first {preview.rows.length})</summary>
					<div class="mt-2 space-y-2 max-h-72 overflow-y-auto">{#each preview.rows as row}
						<div class="rounded border border-[var(--color-border)] p-2 text-sm"><p class="font-medium">{row.quantity}× {row.name} · {row.set.toUpperCase()} #{row.number}</p><p>{row.foil ? 'Foil' : 'Non-Foil'} · {row.language.toUpperCase()} · {row.condition.replaceAll('_', ' ')} · {row.location || 'Unassigned'} · Cost: {row.purchasePrice === null ? 'Unknown' : `€${row.purchasePrice.toFixed(2)}`}{row.duplicate ? ' · Already present' : ''}</p></div>
					{/each}</div>
				</details>
				{#if mode === 'sync'}
					<label class="flex gap-2 items-start text-red-300"><input type="checkbox" bind:checked={confirmReplace} class="mt-1" />Replace all {preview.summary.existingCopies} existing copies ({preview.summary.existingEntries} entries) and their tag assignments with this file.</label>
				{/if}
				<button onclick={() => send('commit')} disabled={!preview.summary.ready || mode === 'sync' && (!confirmReplace || preview.summary.issues > 0)} class="rounded bg-[var(--color-primary-button)] px-4 py-2 disabled:opacity-50">Import {preview.summary.copies} copies</button>
			</section>
		{/if}
	</fieldset>
	{#if message}<p role="status" class="mt-4 {done ? 'text-green-400' : 'text-red-400'}">{message}</p>{/if}
</dialog>

<style>dialog::backdrop { background: #000a; }</style>
