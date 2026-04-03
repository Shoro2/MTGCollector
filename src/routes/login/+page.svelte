<script lang="ts">
	import { page } from '$app/state';

	const error = $derived(page.url.searchParams.get('error'));
</script>

<div class="min-h-[70vh] flex items-center justify-center">
	<div class="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-8 w-full max-w-sm text-center space-y-6">
		<div>
			<h1 class="text-3xl font-bold text-[var(--color-accent)] mb-2">MTG Collector</h1>
			<p class="text-[var(--color-text-muted)] text-sm">Track your Magic: The Gathering collection</p>
		</div>

		{#if error}
			<div class="bg-red-900/30 border border-red-800 rounded-lg p-3 text-sm text-red-400">
				{error === 'invalid_state' ? 'Login expired. Please try again.' : 'Authentication failed. Please try again.'}
			</div>
		{/if}

		<a
			href="/auth/login/google"
			class="flex items-center justify-center gap-3 w-full bg-white text-gray-800 font-medium px-4 py-3 rounded-lg hover:bg-gray-100 transition-colors"
		>
			<svg class="w-5 h-5" viewBox="0 0 24 24">
				<path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
				<path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
				<path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
				<path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
			</svg>
			Sign in with Google
		</a>

		<p class="text-xs text-[var(--color-text-muted)]">
			Sign in to create and manage your personal card collection.
		</p>
	</div>
</div>
