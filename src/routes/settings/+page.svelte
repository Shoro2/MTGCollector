<script lang="ts">
	import { goto } from '$app/navigation';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let showDeleteDialog = $state(false);
	let deleteConfirmText = $state('');
	let deleting = $state(false);
	let deleteError = $state('');

	const canDelete = $derived(deleteConfirmText === 'LÖSCHEN');

	async function deleteAccount() {
		if (!canDelete) return;
		deleting = true;
		deleteError = '';

		try {
			const res = await fetch('/api/account', { method: 'DELETE' });
			if (!res.ok) {
				const data = await res.json();
				deleteError = data.message || 'Fehler beim Löschen des Kontos.';
				return;
			}
			goto('/', { invalidateAll: true });
		} catch {
			deleteError = 'Netzwerkfehler. Bitte versuche es erneut.';
		} finally {
			deleting = false;
		}
	}
</script>

<div class="max-w-2xl mx-auto space-y-6">
	<h1 class="text-2xl font-bold">Einstellungen</h1>

	<!-- Account Info -->
	<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-6">
		<h2 class="text-lg font-semibold mb-4">Kontoinformationen</h2>
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
		<p class="text-xs text-[var(--color-text-muted)]">Angemeldet über Google. Kontodaten können nur bei Google geändert werden.</p>
	</div>

	<!-- Collection Stats -->
	<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-6">
		<h2 class="text-lg font-semibold mb-4">Sammlungsstatistiken</h2>
		<div class="grid grid-cols-3 gap-4">
			<div class="text-center">
				<p class="text-2xl font-bold text-[var(--color-accent)]">{data.collectionCount}</p>
				<p class="text-xs text-[var(--color-text-muted)]">Karten in Sammlung</p>
			</div>
			<div class="text-center">
				<p class="text-2xl font-bold text-[var(--color-accent)]">{data.wishlistCount}</p>
				<p class="text-xs text-[var(--color-text-muted)]">Wunschliste</p>
			</div>
			<div class="text-center">
				<p class="text-2xl font-bold text-[var(--color-accent)]">{data.tagCount}</p>
				<p class="text-xs text-[var(--color-text-muted)]">Tags</p>
			</div>
		</div>
	</div>

	<!-- Delete Account -->
	<div class="bg-[var(--color-surface)] rounded-lg border border-red-500/30 p-6">
		<h2 class="text-lg font-semibold text-red-400 mb-2">Konto löschen</h2>
		<p class="text-sm text-[var(--color-text-muted)] mb-4">
			Wenn du dein Konto löschst, werden alle deine Daten unwiderruflich entfernt:
			Sammlung, Wunschliste, Tags und Einstellungen. Diese Aktion kann nicht rückgängig gemacht werden.
		</p>
		<button
			onclick={() => { showDeleteDialog = true; deleteConfirmText = ''; deleteError = ''; }}
			class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors"
		>
			Konto löschen
		</button>
	</div>
</div>

<!-- Delete Confirmation Dialog -->
{#if showDeleteDialog}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
	<div class="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onclick={(e) => { if (e.target === e.currentTarget) showDeleteDialog = false; }} role="dialog" aria-modal="true" aria-label="Konto löschen bestätigen">
		<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-6 max-w-md w-full">
			<h3 class="text-lg font-semibold text-red-400 mb-3">Konto endgültig löschen?</h3>
			<p class="text-sm text-[var(--color-text-muted)] mb-4">
				Folgende Daten werden unwiderruflich gelöscht:
			</p>
			<ul class="text-sm text-[var(--color-text-muted)] mb-4 list-disc list-inside space-y-1">
				<li>{data.collectionCount} Karten in deiner Sammlung</li>
				<li>{data.wishlistCount} Einträge auf deiner Wunschliste</li>
				<li>{data.tagCount} Tags</li>
				<li>Alle Sitzungsdaten</li>
			</ul>
			<label class="block text-sm mb-4">
				<span class="text-[var(--color-text-muted)]">Gib <strong class="text-[var(--color-text)]">LÖSCHEN</strong> ein, um zu bestätigen:</span>
				<input
					type="text"
					bind:value={deleteConfirmText}
					placeholder="LÖSCHEN"
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
					Abbrechen
				</button>
				<button
					onclick={deleteAccount}
					disabled={!canDelete || deleting}
					class="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
				>
					{deleting ? 'Wird gelöscht...' : 'Endgültig löschen'}
				</button>
			</div>
		</div>
	</div>
{/if}
