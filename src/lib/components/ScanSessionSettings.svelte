<script lang="ts">
	import { CONDITIONS } from '$lib/collection-fields';
	import { defaultSession, type ScanSession } from '$lib/scanner/session';
	let { value = $bindable<ScanSession>(), sets, locations, disabled = false }: {
		value: ScanSession; sets: { set_code: string; set_name: string }[]; locations: string[]; disabled?: boolean
	} = $props();
</script>

<details class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
	<summary class="cursor-pointer font-medium">Scan settings · {value.setCode ? value.setCode.toUpperCase() : 'All sets'} · {value.language ? value.language.toUpperCase() : 'Detect language'} · {value.finish === 'unknown' ? 'Review finish' : value.finish}</summary>
	<fieldset {disabled} class="mt-3 space-y-3">
		<p class="text-sm text-[var(--color-text-muted)]">Applies to new captures only. Choose a set only when you know all cards belong to it. Clear the settings before scanning a mixed pile.</p>
		<div class="grid gap-3 sm:grid-cols-2">
			<label>Set restriction<select aria-label="Set restriction" bind:value={value.setCode} class="block w-full min-w-0 rounded border p-2 bg-[var(--color-bg)]"><option value="">All sets</option>{#each sets as set}<option value={set.set_code}>{set.set_name} ({set.set_code.toUpperCase()})</option>{/each}</select></label>
			<label>Card language<select aria-label="Card language" bind:value={value.language} class="block w-full rounded border p-2 bg-[var(--color-bg)]"><option value="">Detect automatically</option><option value="de">German</option><option value="en">English</option></select></label>
			<label>Finish<select aria-label="Finish" bind:value={value.finish} class="block w-full rounded border p-2 bg-[var(--color-bg)]"><option value="unknown">Detect / review per card</option><option value="foil">All cards are Foil</option><option value="nonfoil">All cards are Non-Foil</option></select></label>
			<label>Condition<select aria-label="Condition" bind:value={value.condition} class="block w-full rounded border p-2 bg-[var(--color-bg)]">{#each CONDITIONS as c}<option value={c.value}>{c.label}</option>{/each}</select></label>
			<label class="sm:col-span-2">Save to location<input bind:value={value.location} maxlength="120" list="scan-locations" placeholder="Unassigned" class="block w-full rounded border p-2 bg-[var(--color-bg)]" /></label>
		</div>
		<datalist id="scan-locations">{#each locations as location}<option value={location}></option>{/each}</datalist>
		<button onclick={() => value = defaultSession()} class="rounded border px-3 py-2">Reset scan settings</button>
	</fieldset>
</details>
