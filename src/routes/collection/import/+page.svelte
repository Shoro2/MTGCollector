<script lang="ts">
	import { invalidateAll } from '$app/navigation';

	let mode = $state<'sync' | 'append'>('append');
	let fileInput = $state<HTMLInputElement>(null!);
	let selectedFile = $state<File | null>(null);
	let importing = $state(false);
	let result = $state<{
		success: boolean;
		imported: number;
		notFound: number;
		notFoundCards: string[];
		total: number;
		mode: string;
		message?: string;
	} | null>(null);
	let confirmSync = $state(false);

	function onFileChange(e: Event) {
		const input = e.target as HTMLInputElement;
		selectedFile = input.files?.[0] ?? null;
		result = null;
	}

	async function doImport() {
		if (!selectedFile) return;

		if (mode === 'sync' && !confirmSync) {
			confirmSync = true;
			return;
		}

		importing = true;
		confirmSync = false;

		const formData = new FormData();
		formData.append('file', selectedFile);
		formData.append('mode', mode);

		const response = await fetch('/collection/import', {
			method: 'POST',
			body: formData
		});

		result = await response.json();
		importing = false;

		if (result?.success) {
			await invalidateAll();
		}
	}
</script>

<svelte:head>
	<title>Import Collection | MTG Collector</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="space-y-6 max-w-2xl">
	<div>
		<a href="/collection" class="text-[var(--color-primary)] hover:underline text-sm">&larr; Back to collection</a>
		<h1 class="text-2xl font-bold mt-2">Import from Moxfield</h1>
		<p class="text-[var(--color-text-muted)] mt-1">
			Import your collection from a Moxfield CSV export.
		</p>
	</div>

	<!-- Instructions -->
	<div class="bg-[var(--color-surface)] rounded-lg p-4 border border-[var(--color-border)] text-sm space-y-2">
		<p class="font-medium">How to export from Moxfield:</p>
		<ol class="list-decimal list-inside text-[var(--color-text-muted)] space-y-1">
			<li>Go to your Moxfield collection</li>
			<li>Click the export/download button</li>
			<li>Choose CSV format</li>
			<li>Upload the downloaded file here</li>
		</ol>
	</div>

	<!-- Mode Selection -->
	<div class="space-y-3">
		<p class="text-sm font-medium">Import Mode</p>
		<div class="flex flex-col sm:flex-row gap-3 sm:gap-4">
			<label class="flex items-start gap-3 bg-[var(--color-surface)] rounded-lg p-4 border cursor-pointer transition-colors {mode === 'append' ? 'border-[var(--color-primary)]' : 'border-[var(--color-border)]'}">
				<input type="radio" bind:group={mode} value="append" class="mt-1" />
				<div>
					<p class="font-medium">Append</p>
					<p class="text-xs text-[var(--color-text-muted)]">
						Add imported cards to your existing collection. Duplicates will be added as separate entries.
					</p>
				</div>
			</label>
			<label class="flex items-start gap-3 bg-[var(--color-surface)] rounded-lg p-4 border cursor-pointer transition-colors {mode === 'sync' ? 'border-[var(--color-primary)]' : 'border-[var(--color-border)]'}">
				<input type="radio" bind:group={mode} value="sync" class="mt-1" />
				<div>
					<p class="font-medium">Sync</p>
					<p class="text-xs text-[var(--color-text-muted)]">
						Replace your entire collection with the import. All existing cards and tags will be removed.
					</p>
				</div>
			</label>
		</div>
	</div>

	<!-- File Upload -->
	<div>
		<label for="csv-file" class="block text-sm font-medium mb-2">CSV File</label>
		<input
			id="csv-file"
			type="file"
			accept=".csv"
			onchange={onFileChange}
			bind:this={fileInput}
			class="block w-full text-sm text-[var(--color-text-muted)]
				file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0
				file:text-sm file:font-medium file:bg-[var(--color-primary-button)]
				file:text-white file:cursor-pointer hover:file:bg-[var(--color-primary-hover)]"
		/>
		{#if selectedFile}
			<p class="text-xs text-[var(--color-text-muted)] mt-1">{selectedFile.name} ({(selectedFile.size / 1024).toFixed(1)} KB)</p>
		{/if}
	</div>

	<!-- Sync Warning -->
	{#if confirmSync}
		<div class="bg-red-900/30 border border-red-500/50 rounded-lg p-4">
			<p class="text-red-300 font-medium">Warning: This will delete your entire collection!</p>
			<p class="text-red-300/70 text-sm mt-1">All existing cards and tag assignments will be removed and replaced with the import.</p>
			<div class="flex gap-2 mt-3">
				<button
					onclick={doImport}
					disabled={importing}
					class="bg-red-600 hover:bg-red-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
				>
					{importing ? 'Importing...' : 'Confirm Sync'}
				</button>
				<button
					onclick={() => confirmSync = false}
					class="bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] px-4 py-2 rounded-lg text-sm border border-[var(--color-border)] transition-colors"
				>
					Cancel
				</button>
			</div>
		</div>
	{:else}
		<button
			onclick={doImport}
			disabled={!selectedFile || importing}
			class="bg-[var(--color-primary-button)] hover:bg-[var(--color-primary-button-hover)] px-6 py-2.5 rounded-lg font-medium transition-colors disabled:opacity-50"
		>
			{importing ? 'Importing...' : `Import (${mode === 'sync' ? 'Sync' : 'Append'})`}
		</button>
	{/if}

	<!-- Result -->
	{#if result}
		<div class="rounded-lg p-4 border {result.success ? 'bg-green-900/20 border-green-500/50' : 'bg-red-900/20 border-red-500/50'}">
			{#if result.success}
				<p class="font-medium text-green-300">
					Import complete! {result.imported} of {result.total} cards imported.
				</p>
				{#if result.mode === 'sync'}
					<p class="text-sm text-green-300/70 mt-1">Collection was replaced (sync mode).</p>
				{:else}
					<p class="text-sm text-green-300/70 mt-1">Cards were added to your collection (append mode).</p>
				{/if}
				{#if result.notFound > 0}
					<div class="mt-3">
						<p class="text-sm text-yellow-300">
							{result.notFound} cards could not be found in the database:
						</p>
						<ul class="text-xs text-yellow-300/70 mt-1 list-disc list-inside max-h-40 overflow-y-auto">
							{#each result.notFoundCards as card}
								<li>{card}</li>
							{/each}
							{#if result.notFound > result.notFoundCards.length}
								<li>...and {result.notFound - result.notFoundCards.length} more</li>
							{/if}
						</ul>
					</div>
				{/if}
			{:else}
				<p class="font-medium text-red-300">{result.message || 'Import failed.'}</p>
			{/if}
		</div>
	{/if}
</div>
