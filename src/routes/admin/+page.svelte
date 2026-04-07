<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	let updating = $state(false);
	let updateMsg = $state('');

	async function toggleMessageHandled(id: number, currentlyHandled: number) {
		await fetch('/admin/api', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'mark_message_handled', id, handled: !currentlyHandled })
		});
		await invalidateAll();
	}

	async function deleteMessage(id: number) {
		if (!confirm('Diese Nachricht wirklich löschen?')) return;
		await fetch('/admin/api', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'delete_message', id })
		});
		await invalidateAll();
	}

	async function triggerPriceUpdate() {
		updating = true;
		updateMsg = 'Triggering price update...';
		const res = await fetch('/api/prices', { method: 'POST' });
		const result = await res.json();
		updating = false;
		updateMsg = result.message || (result.success ? 'Update started' : 'Failed');
	}

	async function cleanupSessions() {
		const res = await fetch('/admin/api', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'cleanup_sessions' })
		});
		const result = await res.json();
		updateMsg = result.message;
	}

	function formatDate(d: unknown): string {
		if (!d) return '—';
		return new Date(d as string).toLocaleString();
	}

	function formatNum(n: number): string {
		return n.toLocaleString();
	}
</script>

<svelte:head>
	<title>Admin Dashboard | MTG Collector</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="space-y-8">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold">Admin Dashboard</h1>
		<span class="text-xs text-[var(--color-text-muted)] bg-[var(--color-surface)] px-3 py-1 rounded-full border border-[var(--color-border)]">Admin</span>
	</div>

	{#if updateMsg}
		<div class="bg-[var(--color-surface)] rounded-lg p-3 border border-[var(--color-border)] text-sm text-[var(--color-text-muted)]">
			{updateMsg}
		</div>
	{/if}

	<!-- Quick Actions -->
	<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)]">
		<h2 class="text-lg font-semibold mb-4">Actions</h2>
		<div class="flex gap-3 flex-wrap">
			<button
				onclick={triggerPriceUpdate}
				disabled={updating}
				class="bg-[var(--color-primary-button)] hover:bg-[var(--color-primary-button-hover)] px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50"
			>
				{updating ? 'Updating...' : 'Trigger Price Update'}
			</button>
			<button
				onclick={cleanupSessions}
				class="bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] border border-[var(--color-border)] px-4 py-2 rounded-lg text-sm transition-colors"
			>
				Cleanup Expired Sessions
			</button>
		</div>
		<p class="text-xs text-[var(--color-text-muted)] mt-3">
			Last price update: {data.priceStatus.lastUpdate ? formatDate(data.priceStatus.lastUpdate) : 'Never'}
			{#if data.priceStatus.inProgress} — <span class="text-yellow-400">Update in progress</span>{/if}
		</p>
	</div>

	<!-- Contact Messages -->
	<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)]">
		<div class="flex items-center justify-between mb-4">
			<h2 class="text-lg font-semibold">Contact Messages</h2>
			{#if data.unhandledContactCount > 0}
				<span class="text-xs bg-yellow-900/40 text-yellow-300 px-2 py-1 rounded-full border border-yellow-700/50">
					{data.unhandledContactCount} unhandled
				</span>
			{/if}
		</div>
		{#if data.contactMessages.length === 0}
			<p class="text-sm text-[var(--color-text-muted)]">No messages yet.</p>
		{:else}
			<div class="space-y-3">
				{#each data.contactMessages as msg (msg.id)}
					<details class="border border-[var(--color-border)] rounded-lg" class:opacity-60={msg.handled}>
						<summary class="px-4 py-3 cursor-pointer flex items-center justify-between gap-3 hover:bg-[var(--color-surface-hover)]">
							<div class="flex items-center gap-3 min-w-0">
								{#if !msg.handled}
									<span class="w-2 h-2 rounded-full bg-yellow-400 flex-shrink-0"></span>
								{/if}
								<span class="font-medium truncate">{msg.name}</span>
								<span class="text-xs text-[var(--color-text-muted)] truncate">&lt;{msg.email}&gt;</span>
								{#if msg.subject}
									<span class="text-xs text-[var(--color-text-muted)] truncate">— {msg.subject}</span>
								{/if}
							</div>
							<span class="text-xs text-[var(--color-text-muted)] flex-shrink-0">{formatDate(msg.created_at)}</span>
						</summary>
						<div class="px-4 py-3 border-t border-[var(--color-border)] space-y-3">
							<pre class="whitespace-pre-wrap text-sm text-[var(--color-text)] font-sans">{msg.message}</pre>
							<div class="flex gap-2">
								<a
									href={`mailto:${msg.email}?subject=Re: ${msg.subject ?? 'Your message'}`}
									class="text-xs bg-[var(--color-primary-button)] hover:bg-[var(--color-primary-button-hover)] px-3 py-1.5 rounded transition-colors"
								>
									Reply via mail
								</a>
								<button
									onclick={() => toggleMessageHandled(msg.id, msg.handled)}
									class="text-xs bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] border border-[var(--color-border)] px-3 py-1.5 rounded transition-colors"
								>
									{msg.handled ? 'Mark unhandled' : 'Mark handled'}
								</button>
								<button
									onclick={() => deleteMessage(msg.id)}
									class="text-xs bg-red-900/30 hover:bg-red-900/50 border border-red-700/50 text-red-300 px-3 py-1.5 rounded transition-colors"
								>
									Delete
								</button>
							</div>
						</div>
					</details>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Google Vision API Usage -->
	<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)]">
		<h2 class="text-lg font-semibold mb-4">Google Vision API</h2>
		<div class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
			<div>
				<p class="text-xs text-[var(--color-text-muted)]">Requests (diesen Monat)</p>
				<p class="text-2xl font-bold">{data.visionUsage.thisMonth}<span class="text-sm font-normal text-[var(--color-text-muted)]"> / 1.000</span></p>
			</div>
			<div>
				<p class="text-xs text-[var(--color-text-muted)]">Bilder (diesen Monat)</p>
				<p class="text-2xl font-bold">{formatNum(data.visionUsage.thisMonthImages)}</p>
			</div>
			<div>
				<p class="text-xs text-[var(--color-text-muted)]">Requests (gesamt)</p>
				<p class="text-2xl font-bold">{formatNum(data.visionUsage.total)}</p>
			</div>
			<div>
				<p class="text-xs text-[var(--color-text-muted)]">Bilder (gesamt)</p>
				<p class="text-2xl font-bold">{formatNum(data.visionUsage.totalImages)}</p>
			</div>
		</div>
		{#if data.visionUsage.thisMonth >= 900}
			<div class="text-sm text-red-400 mb-4">Achtung: {data.visionUsage.thisMonth} / 1.000 Free-Tier Requests diesen Monat verbraucht!</div>
		{/if}
		{#if data.visionUsage.recentCalls.length > 0}
			<details>
				<summary class="text-sm text-[var(--color-text-muted)] cursor-pointer hover:text-[var(--color-text)]">Letzte API-Calls ({data.visionUsage.recentCalls.length})</summary>
				<div class="mt-2 overflow-x-auto">
					<table class="w-full text-sm">
						<thead>
							<tr class="text-left text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
								<th class="py-1 pr-4">Zeitpunkt</th>
								<th class="py-1 pr-4">Requests</th>
								<th class="py-1 pr-4">Bilder</th>
							</tr>
						</thead>
						<tbody>
							{#each data.visionUsage.recentCalls as call}
								<tr class="border-b border-[var(--color-border)]">
									<td class="py-1 pr-4">{formatDate(call.created_at)}</td>
									<td class="py-1 pr-4">{call.request_count}</td>
									<td class="py-1 pr-4">{call.image_count}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</details>
		{:else}
			<p class="text-sm text-[var(--color-text-muted)]">Noch keine API-Calls.</p>
		{/if}
	</div>

	<!-- DB Overview -->
	<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)]">
		<h2 class="text-lg font-semibold mb-4">Database Overview</h2>
		<div class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
			<div class="bg-[var(--color-bg)] rounded-lg p-3">
				<p class="text-xs text-[var(--color-text-muted)]">DB Size</p>
				<p class="text-xl font-bold">{data.dbStats.dbSizeMB} MB</p>
			</div>
			<div class="bg-[var(--color-bg)] rounded-lg p-3">
				<p class="text-xs text-[var(--color-text-muted)]">Cards</p>
				<p class="text-xl font-bold">{formatNum(data.dbStats.cardCount)}</p>
			</div>
			<div class="bg-[var(--color-bg)] rounded-lg p-3">
				<p class="text-xs text-[var(--color-text-muted)]">Price History</p>
				<p class="text-xl font-bold">{formatNum(data.dbStats.priceHistoryCount)}</p>
			</div>
			<div class="bg-[var(--color-bg)] rounded-lg p-3">
				<p class="text-xs text-[var(--color-text-muted)]">Users</p>
				<p class="text-xl font-bold">{data.dbStats.userCount}</p>
			</div>
		</div>

		<!-- Table Stats -->
		<h3 class="text-sm font-semibold text-[var(--color-text-muted)] mb-2">Tables</h3>
		<div class="overflow-x-auto">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-[var(--color-border)]">
						<th class="text-left py-2 px-3 text-[var(--color-text-muted)] font-medium">Table</th>
						<th class="text-right py-2 px-3 text-[var(--color-text-muted)] font-medium">Rows</th>
					</tr>
				</thead>
				<tbody>
					{#each data.dbStats.tableStats as table}
						<tr class="border-b border-[var(--color-border)]/30 hover:bg-[var(--color-bg)]">
							<td class="py-2 px-3 font-mono text-xs">{table.name}</td>
							<td class="py-2 px-3 text-right">{formatNum(table.rows)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		{#if data.dbStats.priceRange.earliest}
			<p class="text-xs text-[var(--color-text-muted)] mt-4">
				Price history range: {formatDate(data.dbStats.priceRange.earliest)} — {formatDate(data.dbStats.priceRange.latest)}
			</p>
		{/if}
	</div>

	<!-- Recent Snapshots -->
	{#if data.recentSnapshots.length > 0}
		<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)]">
			<h2 class="text-lg font-semibold mb-4">Recent Price Snapshots</h2>
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-[var(--color-border)]">
							<th class="text-left py-2 px-3 text-[var(--color-text-muted)] font-medium">Date</th>
							<th class="text-right py-2 px-3 text-[var(--color-text-muted)] font-medium">Cards Snapshotted</th>
						</tr>
					</thead>
					<tbody>
						{#each data.recentSnapshots as snap}
							<tr class="border-b border-[var(--color-border)]/30 hover:bg-[var(--color-bg)]">
								<td class="py-2 px-3">{snap.snapshot_date}</td>
								<td class="py-2 px-3 text-right">{formatNum(snap.cards_snapshotted)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}

	<!-- Users -->
	<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)]">
		<h2 class="text-lg font-semibold mb-4">Users ({data.users.length})</h2>
		<div class="space-y-3">
			{#each data.users as user}
				<div class="bg-[var(--color-bg)] rounded-lg p-4 flex items-center gap-4">
					{#if user.avatar_url}
						<img src={user.avatar_url as string} alt="" class="w-10 h-10 rounded-full" referrerpolicy="no-referrer" />
					{:else}
						<div class="w-10 h-10 rounded-full bg-[var(--color-surface)] flex items-center justify-center text-[var(--color-text-muted)]">?</div>
					{/if}
					<div class="flex-1 min-w-0">
						<p class="font-medium">{user.name}</p>
						<p class="text-xs text-[var(--color-text-muted)]">{user.email}</p>
					</div>
					<div class="grid grid-cols-3 gap-6 text-center text-sm">
						<div>
							<p class="font-bold">{user.collection_count}</p>
							<p class="text-xs text-[var(--color-text-muted)]">Unique</p>
						</div>
						<div>
							<p class="font-bold">{user.total_cards}</p>
							<p class="text-xs text-[var(--color-text-muted)]">Cards</p>
						</div>
						<div>
							<p class="font-bold">{user.wishlist_count}</p>
							<p class="text-xs text-[var(--color-text-muted)]">Wishlist</p>
						</div>
					</div>
					<div class="text-right flex-shrink-0">
						<p class="text-xs text-[var(--color-text-muted)]">Joined {formatDate(user.created_at)}</p>
						<p class="text-xs text-[var(--color-text-muted)]">{user.active_sessions} active session{(user.active_sessions as number) !== 1 ? 's' : ''}</p>
					</div>
				</div>
			{/each}
		</div>
	</div>

	<!-- Top Sets -->
	<div class="bg-[var(--color-surface)] rounded-lg p-6 border border-[var(--color-border)]">
		<h2 class="text-lg font-semibold mb-4">Top Sets by Card Count</h2>
		<div class="space-y-1">
			{#each data.topSets as set}
				{@const maxCount = (data.topSets[0]?.count as number) || 1}
				<div class="flex items-center gap-3">
					<span class="w-12 text-right text-xs font-mono text-[var(--color-text-muted)]">{(set.set_code as string).toUpperCase()}</span>
					<div class="flex-1 h-6 bg-[var(--color-bg)] rounded overflow-hidden">
						<div
							class="h-full bg-[var(--color-primary)]/40 rounded flex items-center px-2"
							style="width: {((set.count as number) / maxCount) * 100}%"
						>
							<span class="text-xs truncate">{set.set_name}</span>
						</div>
					</div>
					<span class="w-16 text-right text-xs text-[var(--color-text-muted)]">{formatNum(set.count as number)}</span>
				</div>
			{/each}
		</div>
	</div>
</div>
