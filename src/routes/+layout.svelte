<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: any } = $props();

	let mobileMenuOpen = $state(false);

	type NavItem = {
		href: string;
		label: string;
		protected?: boolean;
		admin?: boolean;
	};

	const navItems: NavItem[] = [
		{ href: '/cards', label: 'Cards' },
		{ href: '/scan', label: 'Scanner' },
		{ href: '/collection', label: 'Collection', protected: true },
		{ href: '/wishlist', label: 'Wishlist', protected: true },
		{ href: '/prices', label: 'Prices', protected: true },
		{ href: '/admin', label: 'Admin', protected: true, admin: true }
	];

	let visibleNavItems = $derived(
		navItems.filter((item) => {
			if (item.admin) return data.user?.isAdmin;
			if (item.protected) return data.user;
			return true;
		})
	);

	function isActive(href: string): boolean {
		return page.url.pathname === href || page.url.pathname.startsWith(href + '/');
	}

	function initials(name: string | null | undefined): string {
		if (!name) return '?';
		return name
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase())
			.join('');
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
	<nav class="app-nav sticky top-0 z-40 border-b border-[var(--color-border)]">
		<div class="mx-auto flex h-[53px] max-w-[1320px] items-center gap-4 px-4 md:px-6">
			<a href="/" class="flex shrink-0 items-center gap-2 no-underline" aria-label="MTG Collector home">
				<span class="brand-mark flex h-7 w-7 items-center justify-center rounded-[7px]">
					<span class="flex gap-0.5">
						<span class="h-1 w-1 rounded-full bg-[var(--pip-w)]"></span>
						<span class="h-1 w-1 rounded-full bg-[var(--pip-u)]"></span>
						<span class="h-1 w-1 rounded-full bg-[var(--pip-r)]"></span>
					</span>
				</span>
				<span class="text-sm font-semibold tracking-normal text-[var(--color-text)]">
					MTG<span class="font-medium text-[var(--color-text-muted)]"> Collector</span>
				</span>
			</a>

			<div class="hidden h-full items-center gap-0.5 md:flex">
				{#each visibleNavItems as item}
					<a
						href={item.href}
						class="relative flex h-full items-center px-3 text-[13px] font-medium no-underline transition-colors {isActive(item.href) ? 'text-[var(--color-text)] shadow-[inset_0_-2px_0_var(--color-accent)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}"
					>
						{item.label}
					</a>
				{/each}
			</div>

			<div class="ml-auto hidden items-center gap-3 md:flex">
				{#if data.user}
					<a
						href="/settings"
						class="flex h-[30px] w-[30px] items-center justify-center rounded-[7px] border border-transparent text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border)] hover:bg-white/5 hover:text-[var(--color-text)]"
						aria-label="Settings"
						title="Settings"
					>
						<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="12" cy="12" r="3"></circle>
							<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5v.2a2 2 0 0 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1h.2a2 2 0 0 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1z"></path>
						</svg>
					</a>
					<div class="flex items-center gap-2 border-l border-[var(--color-border)] pl-3">
						{#if data.user.avatarUrl}
							<img src={data.user.avatarUrl} alt="" class="h-7 w-7 rounded-full" referrerpolicy="no-referrer" />
						{:else}
							<span class="user-initials flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold">
								{initials(data.user.name)}
							</span>
						{/if}
						<span class="hidden max-w-36 truncate text-[13px] font-medium text-[var(--color-text-muted)] lg:inline">{data.user.name}</span>
					</div>
					<form method="POST" action="/auth/logout">
						<button type="submit" class="text-[13px] font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]">
							Logout
						</button>
					</form>
				{:else}
					<a href="/login" class="btn btn-primary min-h-[32px]">Sign in</a>
				{/if}
			</div>

			<div class="ml-auto flex items-center gap-3 md:hidden">
				{#if data.user?.avatarUrl}
					<img src={data.user.avatarUrl} alt="" class="h-7 w-7 rounded-full" referrerpolicy="no-referrer" />
				{/if}
				<button
					type="button"
					onclick={() => (mobileMenuOpen = !mobileMenuOpen)}
					aria-label="Toggle navigation menu"
					aria-expanded={mobileMenuOpen}
					class="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text)] transition-colors hover:bg-white/5 hover:text-[var(--color-accent)]"
				>
					{#if mobileMenuOpen}
						<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
							<path d="M18 6 6 18"></path>
							<path d="m6 6 12 12"></path>
						</svg>
					{:else}
						<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
							<path d="M4 6h16"></path>
							<path d="M4 12h16"></path>
							<path d="M4 18h16"></path>
						</svg>
					{/if}
				</button>
			</div>
		</div>

		{#if mobileMenuOpen}
			<div class="mx-auto flex max-w-[1320px] flex-col gap-1 border-t border-[var(--color-border)] px-3 py-3 md:hidden">
				{#each visibleNavItems as item}
					<a
						href={item.href}
						onclick={() => (mobileMenuOpen = false)}
						class="rounded-lg px-3 py-3 text-sm font-medium no-underline transition-colors {isActive(item.href) ? 'bg-white/5 text-[var(--color-text)]' : 'text-[var(--color-text-muted)] hover:bg-white/5 hover:text-[var(--color-text)]'}"
					>
						{item.label}
					</a>
				{/each}
				<div class="mt-2 flex flex-col gap-1 border-t border-[var(--color-border)] pt-2">
					{#if data.user}
						<div class="px-3 py-2 text-xs text-[var(--color-text-muted)]">Signed in as {data.user.name}</div>
						<a href="/settings" onclick={() => (mobileMenuOpen = false)} class="rounded-lg px-3 py-3 text-sm text-[var(--color-text-muted)] hover:bg-white/5 hover:text-[var(--color-text)]">
							Settings
						</a>
						<form method="POST" action="/auth/logout">
							<button type="submit" class="w-full rounded-lg px-3 py-3 text-left text-sm text-[var(--color-text-muted)] hover:bg-white/5 hover:text-[var(--color-text)]">
								Logout
							</button>
						</form>
					{:else}
						<a href="/login" onclick={() => (mobileMenuOpen = false)} class="rounded-lg px-3 py-3 text-sm text-[var(--color-primary)] hover:bg-white/5">
							Sign in
						</a>
					{/if}
				</div>
			</div>
		{/if}
	</nav>

	<main class="mx-auto w-full max-w-[1320px] flex-1 px-4 py-5 md:px-6 md:py-6">
		{@render children()}
	</main>

	<footer class="border-t border-[var(--color-border-subtle)] px-4 py-5 text-center text-xs text-[var(--color-text-faint)] md:px-6">
		<div class="mb-2 flex justify-center gap-5">
			<a href="/contact" class="transition-colors hover:text-[var(--color-text)]">Contact</a>
			<a href="/impressum" class="transition-colors hover:text-[var(--color-text)]">Legal Notice</a>
			<a href="/datenschutz" class="transition-colors hover:text-[var(--color-text)]">Privacy Policy</a>
		</div>
		<p class="mx-auto max-w-3xl leading-relaxed">
			mtg-collector.com is unofficial Fan Content permitted under the
			<a href="https://company.wizards.com/en/legal/fancontentpolicy" class="underline transition-colors hover:text-[var(--color-text)]" target="_blank" rel="noopener noreferrer">Fan Content Policy</a>.
			Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast.
			&copy;Wizards of the Coast LLC.
		</p>
	</footer>
</div>
