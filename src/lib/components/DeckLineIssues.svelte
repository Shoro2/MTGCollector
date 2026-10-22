<script lang="ts">
	type Line = { line: number; text: string; message: string };
	/** What a list import left out (issues) and where it chose another printing (notes). */
	let { issues, notes }: { issues: Line[]; notes: Line[] } = $props();
</script>

{#if issues.length}
	<div class="rounded-lg border border-amber-500/50 p-3 text-sm">
		<p class="font-medium">{issues.length} {issues.length === 1 ? 'line was' : 'lines were'} not imported:</p>
		<ul class="mt-2 max-h-48 space-y-1 overflow-y-auto">
			{#each issues as issue (issue.line)}<li>Line {issue.line}: <span class="font-mono text-xs">{issue.text}</span>. {issue.message}</li>{/each}
		</ul>
	</div>
{/if}
{#if notes.length}
	<div class="rounded-lg border border-[var(--color-border)] p-3 text-sm">
		<p class="font-medium">Imported with another printing:</p>
		<ul class="mt-2 max-h-48 space-y-1 overflow-y-auto">
			{#each notes as note (note.line)}<li>Line {note.line}: {note.message}</li>{/each}
		</ul>
	</div>
{/if}
