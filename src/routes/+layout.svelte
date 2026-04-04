<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: any } = $props();

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
			<div class="flex gap-4 flex-1">
				<a href="/cards" class="{isActive('/cards') ? 'text-[var(--color-accent)] font-semibold' : 'text-[var(--color-text-muted)]'} hover:text-[var(--color-text)] transition-colors">
					Cards
				</a>
				<a href="/scan" class="{isActive('/scan') ? 'text-[var(--color-accent)] font-semibold' : 'text-[var(--color-text-muted)]'} hover:text-[var(--color-text)] transition-colors">
					Scanner
				</a>
				{#if data.user}
					<a href="/collection" class="{isActive('/collection') ? 'text-[var(--color-accent)] font-semibold' : 'text-[var(--color-text-muted)]'} hover:text-[var(--color-text)] transition-colors">
						Collection
					</a>
					<a href="/wishlist" class="{isActive('/wishlist') ? 'text-[var(--color-accent)] font-semibold' : 'text-[var(--color-text-muted)]'} hover:text-[var(--color-text)] transition-colors">
						Wishlist
					</a>
					<a href="/prices" class="{isActive('/prices') ? 'text-[var(--color-accent)] font-semibold' : 'text-[var(--color-text-muted)]'} hover:text-[var(--color-text)] transition-colors">
						Prices
					</a>
				{/if}
			</div>
			<div class="flex items-center gap-3">
				{#if data.user}
					<div class="flex items-center gap-2">
						{#if data.user.avatarUrl}
							<img src={data.user.avatarUrl} alt="" class="w-7 h-7 rounded-full" referrerpolicy="no-referrer" />
						{/if}
						<span class="text-sm text-[var(--color-text-muted)] hidden sm:inline">{data.user.name}</span>
					</div>
					<form method="POST" action="/auth/logout">
						<button type="submit" class="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
							Logout
						</button>
					</form>
				{:else}
					<a href="/login" class="text-sm text-[var(--color-primary)] hover:underline">Sign in</a>
				{/if}
			</div>
		</div>
	</nav>

	<main class="flex-1 max-w-7xl mx-auto w-full px-6 py-6">
		{@render children()}
	</main>

	<footer class="border-t border-[var(--color-border)] px-6 py-4 text-center text-xs text-[var(--color-text-muted)]">
		<div class="flex justify-center gap-4">
			<a href="/impressum" class="hover:text-[var(--color-text)] transition-colors">Impressum</a>
			<a href="/datenschutz" class="hover:text-[var(--color-text)] transition-colors">Datenschutz</a>
		</div>
	</footer>
</div>
