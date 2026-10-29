<script lang="ts" module>
	type TurnstileApi = {
		render: (el: HTMLElement, options: Record<string, unknown>) => string;
		reset: (id: string) => void;
		remove: (id: string) => void;
	};
	const READY = 'mtgTurnstileReady';
	const SCRIPT = `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=${READY}`;
	const READY_TIMEOUT_MS = 20_000;
	let loading: Promise<TurnstileApi> | null = null;

	/**
	 * Loads Cloudflare's script once per page; a failed load may be retried by the next widget.
	 * api.js sets window.turnstile only after its own load event, so the script's onload is too
	 * early (the widget never appeared on mtg-collector.com, 2026-10-29); Cloudflare calls the
	 * function named by ?onload= once the API is ready.
	 */
	function loadTurnstile(): Promise<TurnstileApi> {
		const scope = window as unknown as { turnstile?: TurnstileApi } & Record<string, unknown>;
		if (scope.turnstile) return Promise.resolve(scope.turnstile);
		loading ??= new Promise<TurnstileApi>((resolve, reject) => {
			const script = document.createElement('script');
			const fail = (message: string) => {
				clearTimeout(timer);
				delete scope[READY];
				script.remove();
				loading = null;
				reject(new Error(message));
			};
			const timer = setTimeout(() => fail('Turnstile did not start.'), READY_TIMEOUT_MS);
			scope[READY] = () => {
				if (!scope.turnstile) return fail('Turnstile did not start.');
				clearTimeout(timer);
				resolve(scope.turnstile);
			};
			script.src = SCRIPT;
			script.setAttribute('data-turnstile', '');
			script.onerror = () => fail('Turnstile could not be loaded.');
			document.head.appendChild(script);
		});
		return loading;
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';

	/**
	 * Cloudflare Turnstile widget. `token` holds the answer while it is valid (empty before,
	 * after it expires and after reset()); the widget also puts it into a hidden
	 * `cf-turnstile-response` field, so it works inside a plain form. `action` must match
	 * what the server checks.
	 */
	let { siteKey, action, token = $bindable('') }: { siteKey: string; action: string; token?: string } = $props();

	let element: HTMLDivElement;
	let widget: string | null = null;
	let api: TurnstileApi | null = null;
	let failed = $state(false);

	onMount(() => {
		let gone = false;
		loadTurnstile()
			.then((loaded) => {
				if (gone) return;
				api = loaded;
				widget = loaded.render(element, {
					sitekey: siteKey,
					action,
					theme: 'dark',
					callback: (value: string) => (token = value),
					'expired-callback': () => (token = ''),
					'error-callback': () => {
						token = '';
					}
				});
			})
			.catch(() => (failed = true));
		return () => {
			gone = true;
			token = '';
			if (api && widget !== null) api.remove(widget);
		};
	});

	/** A token is good for one check: call this after every submit that sent one. */
	export function reset() {
		token = '';
		if (api && widget !== null) api.reset(widget);
	}
</script>

<div bind:this={element} data-turnstile-widget class="min-h-[65px]"></div>
{#if failed}
	<p role="alert" class="text-sm text-red-400">
		The check "Verify you are human" could not be loaded. Allow challenges.cloudflare.com in your browser or blocker, then reload the page.
	</p>
{/if}
