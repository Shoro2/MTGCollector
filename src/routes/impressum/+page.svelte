<script lang="ts">
	let lang = $state<'de' | 'en'>('en');
</script>

<svelte:head>
	<title>Legal Notice | MTG Collector</title>
	<meta name="description" content="Legal notice (Impressum) for MTG Collector pursuant to Section 5 DDG." />
	<link rel="canonical" href="https://mtg-collector.com/impressum" />
</svelte:head>

<div class="prose prose-invert max-w-4xl mx-auto">
	<p class="disclaimer">
		Note: The German text is the legally binding version pursuant to German law. The English translation is provided for convenience only and has no legal effect. In case of any discrepancy, the German version prevails.
	</p>

	<div class="tabs">
		<button class="tab" class:active={lang === 'en'} onclick={() => lang = 'en'}>English</button>
		<button class="tab" class:active={lang === 'de'} onclick={() => lang = 'de'}>Deutsch</button>
	</div>

	{#if lang === 'en'}
		<h1>Legal Notice</h1>

		<h2>Information pursuant to Section 5 DDG (German Digital Services Act)</h2>
		<p>Christian Assenmacher<br>c/o POSTFLEX PFX-255-117<br>Emsdettener Stra&szlig;e 10<br>48268 Greven<br>Germany</p>

		<h2>Contact</h2>
		<p>Phone: +49 228 96591041<br>Email: info@mtg-collector.com</p>

		<h2>Disclaimer</h2>
		<h3>Liability for Content</h3>
		<p>The contents of our pages were created with the utmost care. However, we cannot guarantee the accuracy, completeness, or timeliness of the content.</p>

		<h3>Liability for Links</h3>
		<p>Our website contains links to external third-party websites over whose content we have no influence. Therefore, we cannot accept any liability for such external content.</p>
	{:else}
		<h1>Impressum</h1>

		<h2>Angaben gem&auml;&szlig; &sect; 5 DDG</h2>
		<p>Christian Assenmacher<br>c/o POSTFLEX PFX-255-117<br>Emsdettener Stra&szlig;e 10<br>48268 Greven<br>Deutschland</p>

		<h2>Kontakt</h2>
		<p>Telefon: +49 228 96591041<br>E-Mail: info@mtg-collector.com</p>

		<h2>Haftungsausschluss</h2>
		<h3>Haftung f&uuml;r Inhalte</h3>
		<p>Die Inhalte unserer Seiten wurden mit gr&ouml;&szlig;ter Sorgfalt erstellt. F&uuml;r die Richtigkeit, Vollst&auml;ndigkeit und Aktualit&auml;t der Inhalte k&ouml;nnen wir jedoch keine Gew&auml;hr &uuml;bernehmen.</p>

		<h3>Haftung f&uuml;r Links</h3>
		<p>Unser Angebot enth&auml;lt Links zu externen Webseiten Dritter, auf deren Inhalte wir keinen Einfluss haben. Deshalb k&ouml;nnen wir f&uuml;r diese fremden Inhalte auch keine Gew&auml;hr &uuml;bernehmen.</p>
	{/if}
</div>

<style>
	.prose { color: var(--color-text); }
	.prose h1 { font-size: 1.875rem; font-weight: 700; margin-bottom: 1.5rem; }
	.prose h2 { font-size: 1.25rem; font-weight: 600; margin-top: 2rem; margin-bottom: 0.75rem; }
	.prose h3 { font-size: 1.1rem; font-weight: 600; margin-top: 1.5rem; margin-bottom: 0.5rem; }
	.prose p { margin-bottom: 0.75rem; color: var(--color-text-muted); line-height: 1.7; }
	.disclaimer {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 0.5rem;
		padding: 0.75rem 1rem;
		font-size: 0.875rem;
		color: var(--color-text-muted);
		margin-bottom: 1.5rem;
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
		transition: all 0.15s;
		background: transparent;
		color: var(--color-text-muted);
		border: 1px solid var(--color-border);
	}
	.tab:hover {
		color: var(--color-text);
	}
	.tab.active {
		background: var(--color-primary);
		color: white;
		border-color: var(--color-primary);
	}
</style>
