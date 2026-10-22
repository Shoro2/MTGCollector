<script lang="ts">
	import { formatLegalities, LEGALITY_LABELS, type FormatLegality } from '$lib/legality';

	let {
		legalities,
		headingLevel = 2
	}: {
		legalities: string | Record<string, unknown> | null | undefined;
		headingLevel?: 2 | 3;
	} = $props();

	let formats = $derived(formatLegalities(legalities));
	let groups = $derived(
		[
			{ title: 'Constructed', items: formats.filter((f) => f.group === 'constructed') },
			{ title: 'Commander and multiplayer', items: formats.filter((f) => f.group === 'multiplayer') }
		].filter((g) => g.items.length > 0)
	);
	let restrictedOrBanned = $derived(formats.some((f) => f.status === 'banned' || f.status === 'restricted'));

	function tooltip(f: FormatLegality): string {
		return `${f.label}: ${LEGALITY_LABELS[f.status]}`;
	}
</script>

{#if formats.length > 0}
	<section class="legality" aria-label="Format legality">
		<svelte:element this={`h${headingLevel}`} class="mb-2 text-sm text-[var(--color-text-muted)]">Format legality</svelte:element>
		{#each groups as group (group.title)}
			<p class="legality-group">{group.title}</p>
			<ul class="legality-grid">
				{#each group.items as f (f.format)}
					<li class="legality-item status-{f.status}" title={tooltip(f)}>
						<span class="legality-icon" aria-hidden="true">
							{#if f.status === 'legal'}
								<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" /><path d="M4.6 8.3l2.2 2.2 4.6-4.8" fill="none" /></svg>
							{:else if f.status === 'restricted'}
								<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" /><text x="8" y="11.6" text-anchor="middle">1</text></svg>
							{:else}
								<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" /><path d="M3.6 3.6l8.8 8.8" fill="none" /></svg>
							{/if}
						</span>
						<span class="legality-text">
							<span>{f.label}</span>
							{#if f.status === 'banned' || f.status === 'restricted'}
								<span class="legality-note">{LEGALITY_LABELS[f.status]}</span>
							{:else}
								<span class="sr-only">{LEGALITY_LABELS[f.status]}</span>
							{/if}
						</span>
					</li>
				{/each}
			</ul>
		{/each}
		<p class="legality-key">
			<span class="status-legal"><span aria-hidden="true">●</span> Legal</span>
			<span class="status-not_legal"><span aria-hidden="true">●</span> Not legal</span>
			{#if restrictedOrBanned}
				<span class="status-banned"><span aria-hidden="true">●</span> Banned</span>
				<span class="status-restricted"><span aria-hidden="true">●</span> Restricted (one copy)</span>
			{/if}
			<span>Source: Scryfall</span>
		</p>
	</section>
{/if}

<style>
	.legality-group {
		margin: 0.5rem 0 0.25rem;
		font-size: 0.7rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--color-text-faint);
	}
	.legality-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
		gap: 0.3rem 1rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.legality-item {
		display: flex;
		align-items: flex-start;
		gap: 0.45rem;
		min-width: 0;
		font-size: 0.875rem;
	}
	.legality-icon {
		flex: none;
		width: 1rem;
		height: 1rem;
		margin-top: 0.15rem;
	}
	.legality-icon svg {
		width: 100%;
		height: 100%;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	/* A long label and its banned/restricted note wrap instead of being cut off. */
	.legality-text {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		column-gap: 0.4rem;
		min-width: 0;
	}
	.legality-note {
		font-size: 0.7rem;
		font-weight: 600;
	}
	.status-legal {
		color: var(--color-text);
	}
	.status-legal .legality-icon svg circle {
		fill: var(--color-success);
		stroke: var(--color-success);
	}
	.status-legal .legality-icon svg path {
		stroke: var(--color-bg);
	}
	.status-restricted {
		color: var(--color-warning);
	}
	.status-restricted .legality-icon svg circle {
		fill: var(--color-warning);
		stroke: var(--color-warning);
	}
	.status-restricted .legality-icon svg text {
		fill: var(--color-bg);
		font-size: 9px;
		font-weight: 700;
	}
	.status-banned {
		color: var(--color-danger);
	}
	.status-banned .legality-icon svg {
		stroke: var(--color-danger);
	}
	.status-not_legal {
		color: var(--color-text-muted);
	}
	.status-not_legal .legality-icon svg {
		stroke: var(--color-text-faint);
	}
	.legality-key {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.9rem;
		margin-top: 0.6rem;
		font-size: 0.72rem;
		color: var(--color-text-faint);
	}
	.legality-key .status-legal {
		color: var(--color-success);
	}
	.legality-key .status-not_legal {
		color: var(--color-text-faint);
	}
</style>
