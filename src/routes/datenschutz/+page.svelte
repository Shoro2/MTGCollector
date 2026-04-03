<script lang="ts">
	let { data } = $props();
</script>

<div class="legal-content max-w-4xl mx-auto">
	{@html data.content}
</div>

<style>
	.legal-content { color: var(--color-text); }
	.legal-content :global(h1) { font-size: 1.875rem; font-weight: 700; margin-bottom: 1.5rem; }
	.legal-content :global(h2) { font-size: 1.25rem; font-weight: 600; margin-top: 2rem; margin-bottom: 0.75rem; }
	.legal-content :global(h3) { font-size: 1.1rem; font-weight: 600; margin-top: 1.5rem; margin-bottom: 0.5rem; }
	.legal-content :global(p) { margin-bottom: 0.75rem; color: var(--color-text-muted); line-height: 1.7; }
	.legal-content :global(ul) { list-style: disc; padding-left: 1.5rem; margin-bottom: 0.75rem; color: var(--color-text-muted); line-height: 1.7; }
	.legal-content :global(li) { margin-bottom: 0.5rem; }
	.legal-content :global(a) { color: var(--color-primary); text-decoration: underline; }
	.legal-content :global(.index) { list-style: none; padding-left: 0; }
	.legal-content :global(.index li) { margin-bottom: 0.25rem; }
</style>
