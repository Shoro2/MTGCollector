<script lang="ts">
	import { goto } from '$app/navigation';
	import { enhance } from '$app/forms';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let showDeleteDialog = $state(false);
	let deleteConfirmText = $state('');
	let deleting = $state(false);
	let deleteError = $state('');

	let visionKeyInput = $state('');
	let savingVisionKey = $state(false);
	let clearingVisionKey = $state(false);

	const canDelete = $derived(deleteConfirmText === 'DELETE');

	async function deleteAccount() {
		if (!canDelete) return;
		deleting = true;
		deleteError = '';

		try {
			const res = await fetch('/api/account', { method: 'DELETE' });
			if (!res.ok) {
				const data = await res.json();
				deleteError = data.message || 'Error deleting account.';
				return;
			}
			goto('/', { invalidateAll: true });
		} catch {
			deleteError = 'Network error. Please try again.';
		} finally {
			deleting = false;
		}
	}
</script>

<svelte:head>
	<title>Settings | MTG Collector</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="max-w-2xl mx-auto space-y-6">
	<h1 class="text-2xl font-bold">Settings</h1>

	<!-- Account Info -->
	<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-6">
		<h2 class="text-lg font-semibold mb-4">Account Information</h2>
		<div class="flex items-center gap-4 mb-4">
			{#if data.user?.avatarUrl}
				<img src={data.user.avatarUrl} alt="" class="w-16 h-16 rounded-full" referrerpolicy="no-referrer" />
			{:else}
				<div class="w-16 h-16 rounded-full bg-[var(--color-border)] flex items-center justify-center text-2xl font-bold text-[var(--color-text-muted)]">
					{data.user?.name?.charAt(0) ?? '?'}
				</div>
			{/if}
			<div>
				<p class="font-medium text-lg">{data.user?.name}</p>
				<p class="text-sm text-[var(--color-text-muted)]">{data.user?.email}</p>
			</div>
		</div>
		<p class="text-xs text-[var(--color-text-muted)]">Signed in via Google. Account details can only be changed at Google.</p>
	</div>

	<!-- Collection Stats -->
	<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-6">
		<h2 class="text-lg font-semibold mb-4">Collection Statistics</h2>
		<div class="grid grid-cols-3 gap-3 sm:gap-4">
			<div class="text-center min-w-0">
				<p class="text-xl sm:text-2xl font-bold text-[var(--color-accent)] break-words">{data.collectionCount}</p>
				<p class="text-xs text-[var(--color-text-muted)]">Cards in Collection</p>
			</div>
			<div class="text-center min-w-0">
				<p class="text-xl sm:text-2xl font-bold text-[var(--color-accent)] break-words">{data.wishlistCount}</p>
				<p class="text-xs text-[var(--color-text-muted)]">Wishlist</p>
			</div>
			<div class="text-center min-w-0">
				<p class="text-xl sm:text-2xl font-bold text-[var(--color-accent)] break-words">{data.tagCount}</p>
				<p class="text-xs text-[var(--color-text-muted)]">Tags</p>
			</div>
		</div>
	</div>

	<!-- Card Scanner OCR -->
	<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-6">
		<h2 class="text-lg font-semibold mb-2">Card Scanner OCR</h2>
		<p class="text-sm text-[var(--color-text-muted)] mb-4">
			The card scanner uses local OCR (Tesseract.js) by default — no data leaves your browser.
			Optionally, you can provide your own
			<a
				href="https://console.cloud.google.com/apis/library/vision.googleapis.com"
				target="_blank"
				rel="noopener noreferrer"
				class="text-[var(--color-accent)] hover:underline"
			>Google Cloud Vision API key</a>
			to retry cards that local OCR could not identify. When the retry toggle on the scanner page is enabled, only the unrecognized cards are sent to Google's Vision API using your personal credentials. Successful scans never leave your browser. Quota and billing are handled by your own Google Cloud project.
		</p>

		<div class="mb-4">
			{#if data.hasVisionApiKey}
				<div class="flex items-center justify-between gap-4 p-3 rounded border border-green-500/30 bg-green-500/5">
					<div class="text-sm">
						<span class="text-green-400 font-medium">Configured</span>
						<span class="text-[var(--color-text-muted)]"> (ends in <code class="font-mono">{data.visionKeyPreview}</code>)</span>
					</div>
					<form
						method="POST"
						action="?/clearVisionKey"
						use:enhance={() => {
							clearingVisionKey = true;
							return async ({ update }) => {
								await update();
								clearingVisionKey = false;
							};
						}}
					>
						<button
							type="submit"
							disabled={clearingVisionKey}
							class="px-3 py-1.5 text-sm bg-red-600/80 hover:bg-red-600 disabled:opacity-50 text-white rounded transition-colors"
						>
							{clearingVisionKey ? 'Removing...' : 'Remove'}
						</button>
					</form>
				</div>
			{:else}
				<div class="p-3 rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-sm text-[var(--color-text-muted)]">
					Not configured. Batch OCR via Google Vision is disabled — the scanner will use local Tesseract for all scans.
				</div>
			{/if}
		</div>

		<!-- Per-user Vision API usage -->
		{#if data.visionUsage}
			{@const monthRequests = data.visionUsage.monthRequests}
			{@const monthImages = data.visionUsage.monthImages}
			{@const limit = data.visionUsage.monthlyFreeLimit}
			{@const percentRaw = limit > 0 ? (monthImages / limit) * 100 : 0}
			{@const percent = Math.min(100, Math.round(percentRaw))}
			{@const overLimit = monthImages >= limit}
			{@const nearLimit = monthImages >= limit * 0.9 && !overLimit}
			<div class="mb-4 p-4 rounded border border-[var(--color-border)] bg-[var(--color-bg)]">
				<div class="flex items-center justify-between mb-2">
					<h3 class="text-sm font-medium">Your Google Vision usage this month</h3>
					<span class="text-xs text-[var(--color-text-muted)]">resets on the 1st</span>
				</div>
				<div class="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-3">
					<div class="min-w-0">
						<p class="text-xs text-[var(--color-text-muted)]">Images (this month)</p>
						<p class="text-lg sm:text-xl font-bold break-words">{monthImages.toLocaleString()}<span class="text-xs font-normal text-[var(--color-text-muted)]"> / {limit.toLocaleString()}</span></p>
					</div>
					<div class="min-w-0">
						<p class="text-xs text-[var(--color-text-muted)]">Batches (this month)</p>
						<p class="text-lg sm:text-xl font-bold break-words">{monthRequests.toLocaleString()}</p>
					</div>
					<div class="min-w-0">
						<p class="text-xs text-[var(--color-text-muted)]">Images (total)</p>
						<p class="text-lg sm:text-xl font-bold break-words">{data.visionUsage.totalImages.toLocaleString()}</p>
					</div>
					<div class="min-w-0">
						<p class="text-xs text-[var(--color-text-muted)]">Batches (total)</p>
						<p class="text-lg sm:text-xl font-bold break-words">{data.visionUsage.totalRequests.toLocaleString()}</p>
					</div>
				</div>
				<div class="w-full h-2 rounded-full bg-[var(--color-border)] overflow-hidden">
					<div
						class="h-full transition-all duration-300 {overLimit ? 'bg-red-500' : nearLimit ? 'bg-yellow-500' : 'bg-[var(--color-accent)]'}"
						style="width: {percent}%"
					></div>
				</div>
				<p class="mt-2 text-xs text-[var(--color-text-muted)]">
					{#if overLimit}
						<span class="text-red-400 font-medium">You've reached the 1.000-image free tier this month.</span>
						Additional images will be billed by Google to your own Cloud project.
					{:else if nearLimit}
						<span class="text-yellow-400 font-medium">Approaching the free tier limit.</span>
						Google Cloud bills any image beyond {limit.toLocaleString()}/month.
					{:else}
						Google Cloud's free tier covers the first {limit.toLocaleString()} Vision images per month per project. Counts above include only scans made through this app.
					{/if}
				</p>
			</div>
		{/if}

		<form
			method="POST"
			action="?/setVisionKey"
			use:enhance={() => {
				savingVisionKey = true;
				return async ({ update }) => {
					await update();
					savingVisionKey = false;
					visionKeyInput = '';
				};
			}}
			class="space-y-3"
		>
			<label class="block">
				<span class="block text-sm text-[var(--color-text-muted)] mb-1">
					{data.hasVisionApiKey ? 'Replace API key' : 'API key'}
				</span>
				<input
					type="password"
					name="apiKey"
					bind:value={visionKeyInput}
					placeholder="AIza…"
					maxlength="200"
					autocomplete="off"
					class="w-full px-3 py-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] text-sm font-mono"
				/>
			</label>
			{#if form?.setVisionKey && 'error' in form.setVisionKey}
				<p class="text-sm text-red-400">{form.setVisionKey.error}</p>
			{:else if form?.setVisionKey && 'success' in form.setVisionKey}
				<p class="text-sm text-green-400">API key saved.</p>
			{:else if form?.clearVisionKey && 'success' in form.clearVisionKey}
				<p class="text-sm text-green-400">API key removed.</p>
			{/if}
			<div class="flex justify-end">
				<button
					type="submit"
					disabled={savingVisionKey || !visionKeyInput.trim()}
					class="px-4 py-2 bg-[var(--color-accent)] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-opacity"
				>
					{savingVisionKey ? 'Saving...' : data.hasVisionApiKey ? 'Replace key' : 'Save key'}
				</button>
			</div>
			<p class="text-xs text-[var(--color-text-muted)]">
				Your key is stored as plain text in the local database. Only you (and the server administrator) can access it. You can remove it any time.
			</p>
		</form>
	</div>

	<!-- Delete Account -->
	<div class="bg-[var(--color-surface)] rounded-lg border border-red-500/30 p-6">
		<h2 class="text-lg font-semibold text-red-400 mb-2">Delete Account</h2>
		<p class="text-sm text-[var(--color-text-muted)] mb-4">
			If you delete your account, all your data will be permanently removed:
			collection, wishlist, tags, and settings. This action cannot be undone.
		</p>
		<button
			onclick={() => { showDeleteDialog = true; deleteConfirmText = ''; deleteError = ''; }}
			class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors"
		>
			Delete Account
		</button>
	</div>
</div>

<!-- Delete Confirmation Dialog -->
{#if showDeleteDialog}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
	<div class="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onclick={(e) => { if (e.target === e.currentTarget) showDeleteDialog = false; }} role="dialog" aria-modal="true" aria-label="Confirm account deletion">
		<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-6 max-w-md w-full">
			<h3 class="text-lg font-semibold text-red-400 mb-3">Permanently delete account?</h3>
			<p class="text-sm text-[var(--color-text-muted)] mb-4">
				The following data will be permanently deleted:
			</p>
			<ul class="text-sm text-[var(--color-text-muted)] mb-4 list-disc list-inside space-y-1">
				<li>{data.collectionCount} cards in your collection</li>
				<li>{data.wishlistCount} entries on your wishlist</li>
				<li>{data.tagCount} tags</li>
				<li>All session data</li>
			</ul>
			<label class="block text-sm mb-4">
				<span class="text-[var(--color-text-muted)]">Type <strong class="text-[var(--color-text)]">DELETE</strong> to confirm:</span>
				<input
					type="text"
					bind:value={deleteConfirmText}
					placeholder="DELETE"
					class="mt-1 w-full px-3 py-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] text-sm"
					autocomplete="off"
				/>
			</label>
			{#if deleteError}
				<p class="text-sm text-red-400 mb-3">{deleteError}</p>
			{/if}
			<div class="flex gap-3 justify-end">
				<button
					onclick={() => showDeleteDialog = false}
					class="px-4 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
				>
					Cancel
				</button>
				<button
					onclick={deleteAccount}
					disabled={!canDelete || deleting}
					class="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
				>
					{deleting ? 'Deleting...' : 'Delete permanently'}
				</button>
			</div>
		</div>
	</div>
{/if}
