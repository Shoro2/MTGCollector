<script lang="ts">
	import { formatPrice } from '$lib/utils';
	import CardPreview from '$lib/components/CardPreview.svelte';

	let imagePreview = $state('');
	let searchQuery = $state('');
	let setCode = $state('');
	let collectorNumber = $state('');
	let results = $state<Array<Record<string, unknown>>>([]);
	let matchType = $state('');
	let adding = $state<string | null>(null);
	let addedCards = $state<Array<{ id: string; name: string }>>([]);
	let searchMode = $state<'set' | 'name'>('set');

	function onFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		if (input.files?.[0]) {
			imagePreview = URL.createObjectURL(input.files[0]);
		}
	}

	async function searchBySet() {
		if (!setCode.trim() || !collectorNumber.trim()) return;
		const res = await fetch('/collection/scan', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ setCode: setCode.trim().toLowerCase(), collectorNumber: collectorNumber.trim() })
		});
		const data = await res.json();
		results = data.results;
		matchType = data.matchType || 'none';
	}

	async function searchByName() {
		if (searchQuery.trim().length < 2) return;
		const res = await fetch('/collection/scan', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ query: searchQuery.trim() })
		});
		const data = await res.json();
		results = data.results;
		matchType = data.matchType || 'none';
	}

	async function doSearch() {
		if (searchMode === 'set') await searchBySet();
		else await searchByName();
	}

	async function addToCollection(cardId: string, cardName: string) {
		adding = cardId;
		await fetch('/collection', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ cardId, quantity: 1, condition: 'near_mint', foil: false })
		});
		adding = null;
		addedCards = [...addedCards, { id: cardId, name: cardName }];
	}

	function nextCard() {
		setCode = '';
		collectorNumber = '';
		searchQuery = '';
		results = [];
		matchType = '';
		// Focus the first input
		setTimeout(() => {
			const el = document.getElementById(searchMode === 'set' ? 'set-code' : 'name-input');
			el?.focus();
		}, 50);
	}

	function getImageSrc(card: Record<string, unknown>): string {
		if (card.local_image_path) return card.local_image_path as string;
		if (card.image_uri) return card.image_uri as string;
		return '';
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold">Add Cards</h1>
		<a href="/collection" class="text-[var(--color-primary)] hover:underline text-sm">&larr; Back to collection</a>
	</div>

	<div class="grid grid-cols-1 md:grid-cols-[1fr_250px] gap-6">
		<!-- Search -->
		<div class="space-y-4">
			<!-- Mode Toggle -->
			<div class="flex gap-2 text-sm">
				<button
					onclick={() => searchMode = 'set'}
					class="px-3 py-1.5 rounded-lg border transition-colors {searchMode === 'set' ? 'bg-[var(--color-primary)] border-[var(--color-primary)] text-white' : 'bg-[var(--color-surface)] border-[var(--color-border)]'}"
				>
					By Set + Number
				</button>
				<button
					onclick={() => searchMode = 'name'}
					class="px-3 py-1.5 rounded-lg border transition-colors {searchMode === 'name' ? 'bg-[var(--color-primary)] border-[var(--color-primary)] text-white' : 'bg-[var(--color-surface)] border-[var(--color-border)]'}"
				>
					By Name
				</button>
			</div>

			<!-- Search Form -->
			<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-4">
				{#if searchMode === 'set'}
					<form onsubmit={(e) => { e.preventDefault(); doSearch(); }} class="flex gap-3 items-end">
						<div>
							<label for="set-code" class="block text-xs text-[var(--color-text-muted)] mb-1">Set Code</label>
							<input
								id="set-code"
								type="text"
								bind:value={setCode}
								placeholder="e.g. tmt"
								class="w-28 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg px-3 py-2 uppercase focus:outline-none focus:border-[var(--color-primary)]"
							/>
						</div>
						<div>
							<label for="collector-num" class="block text-xs text-[var(--color-text-muted)] mb-1">Collector #</label>
							<input
								id="collector-num"
								type="text"
								bind:value={collectorNumber}
								placeholder="e.g. 137"
								class="w-28 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg px-3 py-2 focus:outline-none focus:border-[var(--color-primary)]"
							/>
						</div>
						<button type="submit" class="bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] px-5 py-2 rounded-lg transition-colors">
							Search
						</button>
					</form>
					<p class="text-xs text-[var(--color-text-muted)] mt-2">Find set code and number at the bottom left of the card</p>
				{:else}
					<form onsubmit={(e) => { e.preventDefault(); doSearch(); }} class="flex gap-2">
						<input
							id="name-input"
							type="text"
							bind:value={searchQuery}
							placeholder="English card name..."
							class="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg px-4 py-2 focus:outline-none focus:border-[var(--color-primary)]"
						/>
						<button type="submit" class="bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] px-5 py-2 rounded-lg transition-colors">
							Search
						</button>
					</form>
				{/if}
			</div>

			<!-- Results -->
			{#if results.length > 0}
				<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-4">
					<div class="flex items-center justify-between mb-3">
						<h2 class="text-sm font-semibold">
							{matchType === 'exact' ? 'Exact match' : `${results.length} results`}
						</h2>
					</div>
					<div class="space-y-2">
						{#each results as card}
							{@const imgSrc = getImageSrc(card)}
							{@const isAdded = addedCards.some((a) => a.id === card.id)}
							<div class="flex items-center gap-4 p-2 rounded-lg hover:bg-[var(--color-surface-hover)] transition-colors">
								{#if imgSrc}
									<CardPreview src={imgSrc} alt={card.name as string} scale={2}>
										<img src={imgSrc} alt={card.name as string} class="w-12 h-16 object-cover rounded" loading="lazy" />
									</CardPreview>
								{:else}
									<div class="w-12 h-16 bg-[var(--color-bg)] rounded"></div>
								{/if}
								<div class="flex-1 min-w-0">
									<p class="font-medium">{card.name}</p>
									<p class="text-xs text-[var(--color-text-muted)]">
										{card.set_name} ({(card.set_code as string).toUpperCase()}) #{card.collector_number}
									</p>
								</div>
								<span class="text-sm text-[var(--color-accent)]">{formatPrice(card.price_eur as number | null)}</span>
								{#if isAdded}
									<span class="text-green-400 text-sm w-20 text-center">Added!</span>
								{:else}
									<button
										onclick={() => addToCollection(card.id as string, card.name as string)}
										disabled={adding === card.id}
										class="bg-green-600 hover:bg-green-700 px-4 py-1.5 rounded-lg text-sm transition-colors disabled:opacity-50 w-20"
									>
										{adding === card.id ? '...' : 'Add'}
									</button>
								{/if}
							</div>
						{/each}
					</div>
					{#if results.length > 0}
						<button
							onclick={nextCard}
							class="mt-3 w-full bg-[var(--color-bg)] hover:bg-[var(--color-surface-hover)] py-2 rounded-lg text-sm border border-[var(--color-border)] transition-colors"
						>
							Search next card
						</button>
					{/if}
				</div>
			{:else if (searchQuery.length >= 2 || (setCode && collectorNumber))}
				<div class="text-center py-6 text-[var(--color-text-muted)]">
					<p>No cards found</p>
				</div>
			{/if}
		</div>

		<!-- Reference Photo (optional) -->
		<div class="space-y-3">
			<p class="text-xs text-[var(--color-text-muted)]">Reference photo (optional)</p>
			{#if imagePreview}
				<div class="relative">
					<img src={imagePreview} alt="Card reference" class="w-full rounded-lg" />
					<button
						onclick={() => imagePreview = ''}
						class="absolute top-1.5 right-1.5 bg-black/60 text-white rounded-full w-6 h-6 flex items-center justify-center text-sm hover:bg-black/80"
					>&times;</button>
				</div>
			{:else}
				<label class="flex flex-col items-center justify-center h-40 border-2 border-dashed border-[var(--color-border)] rounded-lg cursor-pointer hover:border-[var(--color-primary)] transition-colors">
					<svg class="w-8 h-8 text-[var(--color-text-muted)] mb-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
						<path stroke-linecap="round" stroke-linejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
					</svg>
					<p class="text-xs text-[var(--color-text-muted)]">Upload photo</p>
					<input type="file" accept="image/*" capture="environment" onchange={onFileSelect} class="hidden" />
				</label>
			{/if}

			<!-- Added Cards Log -->
			{#if addedCards.length > 0}
				<div class="bg-green-900/20 border border-green-800 rounded-lg p-3">
					<p class="text-xs text-green-400 font-semibold mb-1">{addedCards.length} added</p>
					<div class="space-y-0.5">
						{#each addedCards as card}
							<p class="text-xs text-green-300 truncate">{card.name}</p>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	</div>
</div>
