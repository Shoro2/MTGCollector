<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let lang = $state<'de' | 'en'>('de');
	let loadedAt = $state(0);
	let submitting = $state(false);

	onMount(() => {
		loadedAt = Date.now();
		if (data.turnstileSiteKey && !document.querySelector('script[data-turnstile]')) {
			const s = document.createElement('script');
			s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
			s.async = true;
			s.defer = true;
			s.setAttribute('data-turnstile', '');
			document.head.appendChild(s);
		}
	});

	const t = $derived(
		lang === 'de'
			? {
					title: 'Kontakt',
					intro: 'Du erreichst uns über das folgende Formular. Wir antworten in der Regel innerhalb weniger Tage.',
					name: 'Name',
					email: 'E-Mail',
					subject: 'Betreff (optional)',
					message: 'Nachricht',
					send: 'Nachricht senden',
					sending: 'Wird gesendet…',
					success: 'Vielen Dank! Deine Nachricht wurde übermittelt.'
				}
			: {
					title: 'Contact',
					intro: 'You can reach us via the form below. We usually reply within a few days.',
					name: 'Name',
					email: 'Email',
					subject: 'Subject (optional)',
					message: 'Message',
					send: 'Send message',
					sending: 'Sending…',
					success: 'Thank you! Your message has been received.'
				}
	);
</script>

<svelte:head>
	<title>{t.title} | MTG Collector</title>
	<meta name="description" content="Contact form for MTG Collector." />
</svelte:head>

<div class="max-w-2xl mx-auto">
	<div class="tabs">
		<button class="tab" class:active={lang === 'de'} onclick={() => (lang = 'de')}>Deutsch</button>
		<button class="tab" class:active={lang === 'en'} onclick={() => (lang = 'en')}>English</button>
	</div>

	<h1 class="text-2xl font-bold mb-2">{t.title}</h1>
	<p class="text-[var(--color-text-muted)] mb-6">{t.intro}</p>

	{#if form?.success}
		<div class="rounded-lg border border-green-700/50 bg-green-900/20 text-green-300 p-4 mb-4">
			{t.success}
		</div>
	{:else}
		<form
			method="POST"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}
			class="space-y-4"
		>
			<input type="hidden" name="loadedAt" value={loadedAt} />
			<!-- Honeypot: hidden from real users, bots will fill it. -->
			<div class="hp" aria-hidden="true">
				<label>
					Website
					<input type="text" name="website" tabindex="-1" autocomplete="off" />
				</label>
			</div>

			<div>
				<label for="name" class="block text-sm font-medium mb-1">{t.name}</label>
				<input
					id="name"
					name="name"
					type="text"
					required
					maxlength="100"
					value={form?.values?.name ?? ''}
					class="input"
				/>
			</div>

			<div>
				<label for="email" class="block text-sm font-medium mb-1">{t.email}</label>
				<input
					id="email"
					name="email"
					type="email"
					required
					maxlength="200"
					value={form?.values?.email ?? ''}
					class="input"
				/>
			</div>

			<div>
				<label for="subject" class="block text-sm font-medium mb-1">{t.subject}</label>
				<input
					id="subject"
					name="subject"
					type="text"
					maxlength="200"
					value={form?.values?.subject ?? ''}
					class="input"
				/>
			</div>

			<div>
				<label for="message" class="block text-sm font-medium mb-1">{t.message}</label>
				<textarea
					id="message"
					name="message"
					required
					minlength="10"
					maxlength="5000"
					rows="6"
					class="input resize-y"
				>{form?.values?.message ?? ''}</textarea>
			</div>

			{#if data.turnstileSiteKey}
				<div class="cf-turnstile" data-sitekey={data.turnstileSiteKey} data-theme="dark"></div>
			{/if}

			{#if form?.error}
				<div class="rounded-lg border border-red-700/50 bg-red-900/20 text-red-300 p-3 text-sm">
					{form.error}
				</div>
			{/if}

			<button
				type="submit"
				disabled={submitting}
				class="bg-[var(--color-primary-button)] hover:bg-[var(--color-primary-button-hover)] disabled:opacity-50 px-5 py-2 rounded-lg text-sm font-medium transition-colors"
			>
				{submitting ? t.sending : t.send}
			</button>
		</form>
	{/if}
</div>

<style>
	.input {
		width: 100%;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 0.375rem;
		padding: 0.5rem 0.75rem;
		color: var(--color-text);
		font-size: 0.875rem;
	}
	.input:focus {
		outline: none;
		border-color: var(--color-primary);
	}
	.hp {
		position: absolute;
		left: -9999px;
		width: 1px;
		height: 1px;
		overflow: hidden;
	}
	.tabs {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 1.5rem;
	}
	.tab {
		padding: 0.5rem 1rem;
		border-radius: 0.375rem;
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		background: transparent;
		color: var(--color-text-muted);
		border: 1px solid var(--color-border);
	}
	.tab.active {
		background: var(--color-primary);
		color: white;
		border-color: var(--color-primary);
	}
</style>
