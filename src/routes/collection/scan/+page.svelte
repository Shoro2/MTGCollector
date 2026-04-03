<script lang="ts">
	import { formatPrice } from '$lib/utils';
	import CardPreview from '$lib/components/CardPreview.svelte';

	let imageFile = $state<File | null>(null);
	let imagePreview = $state('');
	let scanning = $state(false);
	let scanProgress = $state('');
	let ocrText = $state('');
	let searchQuery = $state('');
	let setCode = $state('');
	let collectorNumber = $state('');
	let results = $state<Array<Record<string, unknown>>>([]);
	let matchType = $state('');
	let adding = $state<string | null>(null);
	let addedCards = $state<string[]>([]);
	let searchMode = $state<'name' | 'set'>('set');

	function onFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		if (input.files?.[0]) {
			imageFile = input.files[0];
			imagePreview = URL.createObjectURL(imageFile);
			ocrText = '';
			searchQuery = '';
			setCode = '';
			collectorNumber = '';
			results = [];
			matchType = '';
		}
	}

	/** Crop a portion of the image using canvas */
	function cropImage(file: File, yStart: number, yEnd: number): Promise<Blob> {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				const canvas = document.createElement('canvas');
				const startY = Math.floor(img.height * yStart);
				const cropHeight = Math.floor(img.height * (yEnd - yStart));
				canvas.width = img.width;
				canvas.height = cropHeight;
				const ctx = canvas.getContext('2d')!;
				// White background for better OCR
				ctx.fillStyle = 'white';
				ctx.fillRect(0, 0, canvas.width, canvas.height);
				ctx.drawImage(img, 0, startY, img.width, cropHeight, 0, 0, img.width, cropHeight);
				canvas.toBlob((blob) => {
					if (blob) resolve(blob);
					else reject(new Error('Failed to crop image'));
				}, 'image/png');
			};
			img.onerror = reject;
			img.src = URL.createObjectURL(file);
		});
	}

	async function scanImage() {
		if (!imageFile) return;
		scanning = true;
		scanProgress = 'Loading OCR engine...';

		try {
			const Tesseract = await import('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js');
			const createWorker = Tesseract.createWorker || Tesseract.default?.createWorker;
			if (!createWorker) throw new Error('Failed to load Tesseract.js');
			const worker = await createWorker('eng');

			// 1. Scan card name (top 12% of image)
			scanProgress = 'Reading card name...';
			const nameBlob = await cropImage(imageFile, 0, 0.12);
			const nameResult = await worker.recognize(nameBlob);
			const nameLine = nameResult.data.text
				.split('\n')
				.map((l: string) => l.trim())
				.filter((l: string) => l.length > 1)
				.join(' ')
				.replace(/[^a-zA-Z\s,'-]/g, '')
				.trim();

			// 2. Scan collector number + set code (bottom 6% of image)
			scanProgress = 'Reading set info...';
			const bottomBlob = await cropImage(imageFile, 0.94, 1.0);
			const bottomResult = await worker.recognize(bottomBlob);
			const bottomText = bottomResult.data.text;

			await worker.terminate();

			ocrText = `Name area: ${nameLine}\nBottom area: ${bottomText}`;

			// Try to extract set code and collector number from bottom
			// Format is usually like: "U 0137" and "TMT • DE"
			const numMatch = bottomText.match(/(\d{3,4})/);
			const setMatch = bottomText.match(/([A-Z]{3})/);

			if (numMatch) {
				collectorNumber = numMatch[1].replace(/^0+/, ''); // strip leading zeros
			}
			if (setMatch) {
				setCode = setMatch[1].toLowerCase();
			}

			// If we got set code + number, search by that first
			if (setCode && collectorNumber) {
				searchMode = 'set';
				await searchBySet();
			} else if (nameLine) {
				// Fallback to name search
				searchMode = 'name';
				searchQuery = nameLine;
				await searchCards(nameLine);
			}

			scanProgress = '';
		} catch (err) {
			scanProgress = `Error: ${(err as Error).message}`;
		} finally {
			scanning = false;
		}
	}

	async function searchCards(query: string) {
		const res = await fetch('/collection/scan', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ query })
		});
		const data = await res.json();
		results = data.results;
		matchType = data.matchType || 'none';
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

	async function manualSearch() {
		if (searchMode === 'set') {
			await searchBySet();
		} else {
			if (searchQuery.trim().length < 2) return;
			await searchCards(searchQuery.trim());
		}
	}

	async function addToCollection(cardId: string) {
		adding = cardId;
		await fetch('/collection', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ cardId, quantity: 1, condition: 'near_mint', foil: false })
		});
		adding = null;
		addedCards = [...addedCards, cardId];
	}

	function reset() {
		imageFile = null;
		imagePreview = '';
		ocrText = '';
		searchQuery = '';
		setCode = '';
		collectorNumber = '';
		results = [];
		matchType = '';
		addedCards = [];
	}

	function getImageSrc(card: Record<string, unknown>): string {
		if (card.local_image_path) return card.local_image_path as string;
		if (card.image_uri) return card.image_uri as string;
		return '';
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold">Card Scanner</h1>
		<a href="/collection" class="text-[var(--color-primary)] hover:underline text-sm">&larr; Back to collection</a>
	</div>

	<!-- Upload Area -->
	<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-6">
		<div class="flex gap-6">
			<!-- Image Upload -->
			<div class="flex-1">
				{#if !imagePreview}
					<label class="flex flex-col items-center justify-center h-64 border-2 border-dashed border-[var(--color-border)] rounded-lg cursor-pointer hover:border-[var(--color-primary)] transition-colors">
						<svg class="w-12 h-12 text-[var(--color-text-muted)] mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
							<path stroke-linecap="round" stroke-linejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
							<path stroke-linecap="round" stroke-linejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
						</svg>
						<p class="text-[var(--color-text-muted)]">Click to upload card photo</p>
						<p class="text-xs text-[var(--color-text-muted)] mt-1">or use camera on mobile</p>
						<input type="file" accept="image/*" capture="environment" onchange={onFileSelect} class="hidden" />
					</label>
				{:else}
					<div class="relative">
						<img src={imagePreview} alt="Uploaded card" class="max-h-64 rounded-lg mx-auto" />
						<button
							onclick={reset}
							class="absolute top-2 right-2 bg-black/60 text-white rounded-full w-8 h-8 flex items-center justify-center hover:bg-black/80"
						>&times;</button>
					</div>
				{/if}
			</div>

			<!-- Actions -->
			{#if imagePreview}
				<div class="flex flex-col gap-3 justify-center">
					<button
						onclick={scanImage}
						disabled={scanning}
						class="bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] px-6 py-3 rounded-lg font-medium transition-colors disabled:opacity-50"
					>
						{scanning ? 'Scanning...' : 'Scan Card'}
					</button>
					{#if scanProgress}
						<p class="text-sm text-[var(--color-text-muted)]">{scanProgress}</p>
					{/if}
				</div>
			{/if}
		</div>
	</div>

	<!-- Search Area -->
	<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-4 space-y-3">
		<!-- Mode Toggle -->
		<div class="flex gap-2 text-sm">
			<button
				onclick={() => searchMode = 'set'}
				class="px-3 py-1 rounded-lg border transition-colors {searchMode === 'set' ? 'bg-[var(--color-primary)] border-[var(--color-primary)] text-white' : 'bg-[var(--color-bg)] border-[var(--color-border)]'}"
			>
				By Set + Number
			</button>
			<button
				onclick={() => searchMode = 'name'}
				class="px-3 py-1 rounded-lg border transition-colors {searchMode === 'name' ? 'bg-[var(--color-primary)] border-[var(--color-primary)] text-white' : 'bg-[var(--color-bg)] border-[var(--color-border)]'}"
			>
				By Name
			</button>
		</div>

		{#if searchMode === 'set'}
			<form onsubmit={(e) => { e.preventDefault(); manualSearch(); }} class="flex gap-2 items-end">
				<div>
					<label for="set-code" class="block text-xs text-[var(--color-text-muted)] mb-1">Set Code</label>
					<input
						id="set-code"
						type="text"
						bind:value={setCode}
						placeholder="e.g. tmt"
						class="w-24 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm uppercase focus:outline-none focus:border-[var(--color-primary)]"
					/>
				</div>
				<div>
					<label for="collector-num" class="block text-xs text-[var(--color-text-muted)] mb-1">Collector #</label>
					<input
						id="collector-num"
						type="text"
						bind:value={collectorNumber}
						placeholder="e.g. 137"
						class="w-24 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-primary)]"
					/>
				</div>
				<button
					type="submit"
					class="bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] px-4 py-2 rounded-lg text-sm transition-colors"
				>
					Search
				</button>
			</form>
			<p class="text-xs text-[var(--color-text-muted)]">Find set code and number at the bottom of the card (e.g. "U 0137 &middot; TMT")</p>
		{:else}
			<form onsubmit={(e) => { e.preventDefault(); manualSearch(); }} class="flex gap-2">
				<input
					type="text"
					bind:value={searchQuery}
					placeholder="Card name (English)..."
					class="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-[var(--color-primary)]"
				/>
				<button
					type="submit"
					class="bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] px-4 py-2 rounded-lg text-sm transition-colors"
				>
					Search
				</button>
			</form>
		{/if}

		{#if ocrText}
			<details>
				<summary class="text-xs text-[var(--color-text-muted)] cursor-pointer">Show OCR result</summary>
				<pre class="text-xs text-[var(--color-text-muted)] mt-1 whitespace-pre-wrap bg-[var(--color-bg)] rounded p-2">{ocrText}</pre>
			</details>
		{/if}
	</div>

	<!-- Search Results -->
	{#if results.length > 0}
		<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-4">
			<h2 class="text-sm font-semibold mb-3">
				{matchType === 'exact' ? 'Exact match' : `${results.length} results found`} — select the correct card:
			</h2>
			<div class="space-y-2">
				{#each results as card}
					{@const imgSrc = getImageSrc(card)}
					{@const isAdded = addedCards.includes(card.id as string)}
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
							<span class="text-green-400 text-sm px-4 py-1.5">Added!</span>
						{:else}
							<button
								onclick={() => addToCollection(card.id as string)}
								disabled={adding === card.id}
								class="bg-green-600 hover:bg-green-700 px-4 py-1.5 rounded-lg text-sm transition-colors disabled:opacity-50"
							>
								{adding === card.id ? 'Adding...' : 'Add'}
							</button>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	{:else if (searchQuery || (setCode && collectorNumber)) && !scanning}
		<div class="text-center py-8 text-[var(--color-text-muted)]">
			<p>No cards found</p>
			<p class="text-sm mt-1">Try a different search or switch to {searchMode === 'set' ? 'name' : 'set + number'} search</p>
		</div>
	{/if}

	<!-- Added Cards Summary -->
	{#if addedCards.length > 0}
		<div class="bg-green-900/30 border border-green-700 rounded-lg p-4 text-center">
			<p class="text-green-300">{addedCards.length} card{addedCards.length > 1 ? 's' : ''} added to collection</p>
			<div class="flex gap-3 justify-center mt-3">
				<button onclick={reset} class="bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] px-4 py-2 rounded-lg text-sm transition-colors">
					Scan another card
				</button>
				<a href="/collection" class="bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] px-4 py-2 rounded-lg text-sm border border-[var(--color-border)] transition-colors">
					Go to collection
				</a>
			</div>
		</div>
	{/if}
</div>
