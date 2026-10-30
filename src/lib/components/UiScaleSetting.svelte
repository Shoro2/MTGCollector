<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import {
		parseUiScale,
		rootFontScale,
		uiScaleCookie,
		UI_SCALES,
		UI_SCALE_LABELS,
		type UiScale
	} from '$lib/ui-scale';

	// "Display size" panel on /settings (src/lib/ui-scale.ts): stored per browser in a
	// cookie and applied at once by switching <html data-ui-scale>.
	let { initial }: { initial: string } = $props();

	// The panel owns the choice after the first render; a later layout load does not reset it.
	let scale = $state<UiScale>(untrack(() => parseUiScale(initial)));
	let effective = $state<number | null>(null);

	function measure() {
		effective = Math.round(rootFontScale() * 100);
	}

	function choose(value: UiScale) {
		scale = value;
		document.cookie = uiScaleCookie(value, location.protocol === 'https:');
		document.documentElement.dataset.uiScale = value;
		measure();
	}

	onMount(() => {
		measure();
		window.addEventListener('resize', measure);
		return () => window.removeEventListener('resize', measure);
	});
</script>

<div class="panel p-6" data-ui-scale-setting>
	<h2 class="text-lg font-semibold mb-1">Display size</h2>
	<p class="text-sm text-[var(--color-text-muted)] mb-4">
		Makes text, images and the page width larger or smaller on every page.
		Saved in this browser only, so a large monitor and a phone can use different sizes.
	</p>
	<div class="flex flex-wrap gap-1 rounded-lg bg-[var(--color-bg)] p-1" role="group" aria-label="Display size">
		{#each UI_SCALES as value}
			<button
				type="button"
				onclick={() => choose(value)}
				aria-pressed={scale === value}
				data-scale={value}
				class="min-w-0 flex-1 rounded px-3 py-1.5 text-sm whitespace-nowrap transition-colors {scale === value ? 'bg-[var(--color-primary-button)] text-white' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}"
			>
				{UI_SCALE_LABELS[value]}
			</button>
		{/each}
	</div>
	<p class="mt-3 text-xs text-[var(--color-text-muted)]">
		Automatic keeps the normal size up to a 1920 px wide window and grows on larger screens.
		Phones keep the normal size for the larger settings.
		{#if effective !== null}<span data-ui-scale-effective>Now: {effective} %.</span>{/if}
	</p>
</div>
