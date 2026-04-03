<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';

	let { children } = $props();

	function isActive(href: string): boolean {
		return page.url.pathname === href || page.url.pathname.startsWith(href + '/');
	}
</script>

<svelte:head>
	<title>MTG Collector</title>
</svelte:head>

<div class="min-h-screen flex flex-col">
	<nav class="bg-[var(--color-surface)] border-b border-[var(--color-border)] px-6 py-3">
		<div class="max-w-7xl mx-auto flex items-center gap-8">
			<a href="/" class="text-xl font-bold text-[var(--color-accent)]">MTG Collector</a>
			<div class="flex gap-4">
				<a href="/cards" class="{isActive('/cards') ? 'text-[var(--color-accent)] font-semibold' : 'text-[var(--color-text-muted)]'} hover:text-[var(--color-text)] transition-colors">
					Cards
				</a>
				<a href="/collection" class="{isActive('/collection') ? 'text-[var(--color-accent)] font-semibold' : 'text-[var(--color-text-muted)]'} hover:text-[var(--color-text)] transition-colors">
					Collection
				</a>
				<a href="/prices" class="{isActive('/prices') ? 'text-[var(--color-accent)] font-semibold' : 'text-[var(--color-text-muted)]'} hover:text-[var(--color-text)] transition-colors">
					Prices
				</a>
			</div>
		</div>
	</nav>

	<main class="flex-1 max-w-7xl mx-auto w-full px-6 py-6">
		{@render children()}
	</main>
</div>
