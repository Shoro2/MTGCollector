<script lang="ts">
	import { goto } from '$app/navigation';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let showDeleteDialog = $state(false);
	let deleteConfirmText = $state('');
	let deleting = $state(false);
	let deleteError = $state('');

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
		<div class="grid grid-cols-3 gap-4">
			<div class="text-center">
				<p class="text-2xl font-bold text-[var(--color-accent)]">{data.collectionCount}</p>
				<p class="text-xs text-[var(--color-text-muted)]">Cards in Collection</p>
			</div>
			<div class="text-center">
				<p class="text-2xl font-bold text-[var(--color-accent)]">{data.wishlistCount}</p>
				<p class="text-xs text-[var(--color-text-muted)]">Wishlist</p>
			</div>
			<div class="text-center">
				<p class="text-2xl font-bold text-[var(--color-accent)]">{data.tagCount}</p>
				<p class="text-xs text-[var(--color-text-muted)]">Tags</p>
			</div>
		</div>
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
