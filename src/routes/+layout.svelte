<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: any } = $props();

	let mobileMenuOpen = $state(false);

	function isActive(href: string): boolean {
		return page.url.pathname === href || page.url.pathname.startsWith(href + '/');
	}

	// Close the mobile menu whenever the route changes.
	$effect(() => {
		page.url.pathname;
		mobileMenuOpen = false;
	});
</script>

<svelte:head>
	<title>MTG Collector</title>
	<meta property="og:site_name" content="MTG Collector" />
	<meta property="og:type" content="website" />
	<!-- Privacy-friendly analytics by Plausible (self-hosted) -->
	{@html `<script async src="https://analytics.mtg-collector.com/js/pa-j1cL-J9IoFPVH6UgENBCv.js"></script><script>window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()</script>`}
</svelte:head>

<div class="min-h-screen flex flex-col">
	<nav class="bg-[var(--color-surface)] border-b border-[var(--color-border)] px-4 md:px-6 py-3">
		<div class="max-w-7xl mx-auto flex items-center gap-4 md:gap-8">
			<a href="/" class="text-xl font-bold text-[var(--color-accent)]">MTG Collector</a>

			<!-- Desktop nav links -->
			<div class="hidden md:flex gap-4 flex-1">
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
					{#if data.user.isAdmin}
						<a href="/admin" class="{isActive('/admin') ? 'text-[var(--color-accent)] font-semibold' : 'text-[var(--color-text-muted)]'} hover:text-[var(--color-text)] transition-colors">
							Admin
						</a>
					{/if}
				{/if}
			</div>

			<!-- Desktop user section -->
			<div class="hidden md:flex items-center gap-3">
				{#if data.user}
					<div class="flex items-center gap-2">
						{#if data.user.avatarUrl}
							<img src={data.user.avatarUrl} alt="" class="w-7 h-7 rounded-full" referrerpolicy="no-referrer" />
						{/if}
						<span class="text-sm text-[var(--color-text-muted)] hidden sm:inline">{data.user.name}</span>
					</div>
					<a href="/settings" class="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
						Settings
					</a>
					<form method="POST" action="/auth/logout">
						<button type="submit" class="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
							Logout
						</button>
					</form>
				{:else}
					<a href="/login" class="text-sm text-[var(--color-primary)] hover:underline">Sign in</a>
				{/if}
			</div>

			<!-- Mobile: avatar + burger button -->
			<div class="md:hidden ml-auto flex items-center gap-3">
				{#if data.user?.avatarUrl}
					<img src={data.user.avatarUrl} alt="" class="w-7 h-7 rounded-full" referrerpolicy="no-referrer" />
				{/if}
				<button
					type="button"
					onclick={() => (mobileMenuOpen = !mobileMenuOpen)}
					aria-label="Toggle navigation menu"
					aria-expanded={mobileMenuOpen}
					class="p-2 -mr-2 text-[var(--color-text)] hover:text-[var(--color-accent)] transition-colors"
				>
					{#if mobileMenuOpen}
						<svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
						</svg>
					{:else}
						<svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" />
						</svg>
					{/if}
				</button>
			</div>
		</div>

		<!-- Mobile drawer -->
		{#if mobileMenuOpen}
			<div class="md:hidden mt-3 border-t border-[var(--color-border)] pt-3 flex flex-col gap-1 max-w-7xl mx-auto">
				<a
					href="/cards"
					onclick={() => (mobileMenuOpen = false)}
					class="py-3 px-4 rounded-lg {isActive('/cards') ? 'bg-[var(--color-bg)] text-[var(--color-accent)] font-semibold' : 'text-[var(--color-text-muted)]'} hover:text-[var(--color-text)] transition-colors"
				>
					Cards
				</a>
				<a
					href="/scan"
					onclick={() => (mobileMenuOpen = false)}
					class="py-3 px-4 rounded-lg {isActive('/scan') ? 'bg-[var(--color-bg)] text-[var(--color-accent)] font-semibold' : 'text-[var(--color-text-muted)]'} hover:text-[var(--color-text)] transition-colors"
				>
					Scanner
				</a>
				{#if data.user}
					<a
						href="/collection"
						onclick={() => (mobileMenuOpen = false)}
						class="py-3 px-4 rounded-lg {isActive('/collection') ? 'bg-[var(--color-bg)] text-[var(--color-accent)] font-semibold' : 'text-[var(--color-text-muted)]'} hover:text-[var(--color-text)] transition-colors"
					>
						Collection
					</a>
					<a
						href="/wishlist"
						onclick={() => (mobileMenuOpen = false)}
						class="py-3 px-4 rounded-lg {isActive('/wishlist') ? 'bg-[var(--color-bg)] text-[var(--color-accent)] font-semibold' : 'text-[var(--color-text-muted)]'} hover:text-[var(--color-text)] transition-colors"
					>
						Wishlist
					</a>
					<a
						href="/prices"
						onclick={() => (mobileMenuOpen = false)}
						class="py-3 px-4 rounded-lg {isActive('/prices') ? 'bg-[var(--color-bg)] text-[var(--color-accent)] font-semibold' : 'text-[var(--color-text-muted)]'} hover:text-[var(--color-text)] transition-colors"
					>
						Prices
					</a>
					{#if data.user.isAdmin}
						<a
							href="/admin"
							onclick={() => (mobileMenuOpen = false)}
							class="py-3 px-4 rounded-lg {isActive('/admin') ? 'bg-[var(--color-bg)] text-[var(--color-accent)] font-semibold' : 'text-[var(--color-text-muted)]'} hover:text-[var(--color-text)] transition-colors"
						>
							Admin
						</a>
					{/if}
				{/if}

				<div class="border-t border-[var(--color-border)] mt-2 pt-2 flex flex-col gap-1">
					{#if data.user}
						<div class="py-2 px-4 text-sm text-[var(--color-text-muted)]">
							Signed in as {data.user.name}
						</div>
						<a
							href="/settings"
							onclick={() => (mobileMenuOpen = false)}
							class="py-3 px-4 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
						>
							Settings
						</a>
						<form method="POST" action="/auth/logout" class="block">
							<button
								type="submit"
								class="w-full text-left py-3 px-4 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
							>
								Logout
							</button>
						</form>
					{:else}
						<a
							href="/login"
							onclick={() => (mobileMenuOpen = false)}
							class="py-3 px-4 rounded-lg text-[var(--color-primary)] hover:underline"
						>
							Sign in
						</a>
					{/if}
				</div>
			</div>
		{/if}
	</nav>

	<main class="flex-1 max-w-7xl mx-auto w-full px-4 md:px-6 py-6">
		{@render children()}
	</main>

	<footer class="border-t border-[var(--color-border)] px-4 md:px-6 py-4 text-center text-xs text-[var(--color-text-muted)]">
		<div class="flex justify-center gap-4">
			<a href="/contact" class="hover:text-[var(--color-text)] transition-colors">Contact</a>
			<a href="/impressum" class="hover:text-[var(--color-text)] transition-colors">Legal Notice</a>
			<a href="/datenschutz" class="hover:text-[var(--color-text)] transition-colors">Privacy Policy</a>
		</div>
		<p class="mt-2 max-w-3xl mx-auto leading-relaxed">
			mtg-collector.com is unofficial Fan Content permitted under the
			<a href="https://company.wizards.com/en/legal/fancontentpolicy" class="underline hover:text-[var(--color-text)] transition-colors" target="_blank" rel="noopener noreferrer">Fan Content Policy</a>.
			Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast.
			&copy;Wizards of the Coast LLC.
		</p>
	</footer>
</div>
