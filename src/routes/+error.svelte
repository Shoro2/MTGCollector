<script lang="ts">
	import { page } from '$app/state';
</script>

<svelte:head>
	<title>{page.status} | MTG Collector</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="max-w-xl mx-auto py-16 text-center space-y-4">
	<p class="text-5xl font-bold text-[var(--color-primary)]">{page.status}</p>
	<h1 class="text-2xl font-semibold">
		{#if page.status === 404}
			Page not found
		{:else if page.status === 401}
			Sign in required
		{:else if page.status === 403}
			Access denied
		{:else}
			Something went wrong
		{/if}
	</h1>
	{#if page.error?.message}
		<p class="text-[var(--color-text-muted)]">{page.error.message}</p>
	{/if}
	<div class="flex justify-center gap-3 pt-4">
		<a href="/" class="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white hover:opacity-90">Go home</a>
		<a href="/cards" class="px-4 py-2 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-primary)]">Browse cards</a>
	</div>
</div>
