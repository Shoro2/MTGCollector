<script lang="ts">
	import { formatPrice } from '$lib/utils';
	import CardPreview from '$lib/components/CardPreview.svelte';

	let imagePreview = $state('');
	let scanning = $state(false);
	let scanProgress = $state('');
	let scanFailed = $state(false);
	let setCode = $state('');
	let collectorNumber = $state('');
	let searchQuery = $state('');
	let results = $state<Array<Record<string, unknown>>>([]);
	let matchType = $state('');
	let adding = $state<string | null>(null);
	let addedCards = $state<Array<{ id: string; name: string }>>([]);
	let searchMode = $state<'set' | 'name'>('set');
	let detectedText = $state('');

	function onFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		if (input.files?.[0]) {
			const file = input.files[0];
			imagePreview = URL.createObjectURL(file);
			scanFailed = false;
			results = [];
			detectedText = '';
			scanImage(file);
		}
	}

	/** Crop bottom portion and enhance for OCR */
	function cropBottom(file: File): Promise<Blob> {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				const canvas = document.createElement('canvas');
				// Crop bottom 18% - generous to catch card bottom in photos
				const startY = Math.floor(img.height * 0.82);
				const cropHeight = img.height - startY;
				canvas.width = img.width;
				canvas.height = cropHeight;
				const ctx = canvas.getContext('2d')!;
				ctx.drawImage(img, 0, startY, img.width, cropHeight, 0, 0, img.width, cropHeight);

				// Invert colors - card bottom has light text on dark background
				const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
				const data = imageData.data;
				for (let i = 0; i < data.length; i += 4) {
					data[i] = 255 - data[i];       // R
					data[i + 1] = 255 - data[i + 1]; // G
					data[i + 2] = 255 - data[i + 2]; // B
				}
				ctx.putImageData(imageData, 0, 0);

				// Increase contrast
				ctx.globalCompositeOperation = 'source-over';
				canvas.toBlob((blob) => {
					if (blob) resolve(blob);
					else reject(new Error('Failed to crop'));
				}, 'image/png');
			};
			img.onerror = reject;
			img.src = URL.createObjectURL(file);
		});
	}

	async function scanImage(file: File) {
		scanning = true;
		scanProgress = 'Loading OCR...';
		scanFailed = false;

		try {
			const Tesseract = await import('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js');
			const createWorker = Tesseract.createWorker || Tesseract.default?.createWorker;
			if (!createWorker) throw new Error('Failed to load Tesseract.js');

			const worker = await createWorker('eng');
			scanProgress = 'Reading card info...';

			const bottomBlob = await cropBottom(file);
			const result = await worker.recognize(bottomBlob);
			await worker.terminate();

			const text = result.data.text;
			detectedText = text;

			// Extract collector number: look for patterns like "0047", "C 0047", "U 0137"
			const numMatch = text.match(/\b(\d{3,4})\b/);
			// Extract set code: 3 consecutive uppercase letters
			const setMatch = text.match(/\b([A-Z]{3})\b/);

			if (numMatch && setMatch) {
				setCode = setMatch[1].toLowerCase();
				collectorNumber = numMatch[1].replace(/^0+/, '') || numMatch[1];
				scanProgress = `Found: ${setMatch[1]} #${numMatch[1]}`;

				// Auto-search
				const res = await fetch('/collection/scan', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ setCode: setCode, collectorNumber: collectorNumber })
				});
				const data = await res.json();
				results = data.results;
				matchType = data.matchType || 'none';

				if (results.length === 0) {
					scanFailed = true;
					scanProgress = `Detected ${setMatch[1]} #${numMatch[1]} but no match found`;
				}
			} else {
				scanFailed = true;
				scanProgress = 'Could not read set code / collector number';
			}
		} catch (err) {
			scanFailed = true;
			scanProgress = `Error: ${(err as Error).message}`;
		} finally {
			scanning = false;
		}
	}

	async function manualSearch() {
		if (searchMode === 'set') {
			if (!setCode.trim() || !collectorNumber.trim()) return;
			const res = await fetch('/collection/scan', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ setCode: setCode.trim().toLowerCase(), collectorNumber: collectorNumber.trim() })
			});
			const data = await res.json();
			results = data.results;
			matchType = data.matchType || 'none';
		} else {
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

	function reset() {
		imagePreview = '';
		scanning = false;
		scanProgress = '';
		scanFailed = false;
		setCode = '';
		collectorNumber = '';
		searchQuery = '';
		results = [];
		matchType = '';
		detectedText = '';
	}

	function getImageSrc(card: Record<string, unknown>): string {
		if (card.local_image_path) return card.local_image_path as string;
		if (card.image_uri) return card.image_uri as string;
		return '';
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold">Scan Card</h1>
		<a href="/collection" class="text-[var(--color-primary)] hover:underline text-sm">&larr; Back to collection</a>
	</div>

	<div class="grid grid-cols-1 md:grid-cols-[300px_1fr] gap-6">
		<!-- Left: Photo + Upload -->
		<div class="space-y-3">
			{#if imagePreview}
				<div class="relative">
					<img src={imagePreview} alt="Scanned card" class="w-full rounded-lg" />
					<button
						onclick={reset}
						class="absolute top-1.5 right-1.5 bg-black/60 text-white rounded-full w-7 h-7 flex items-center justify-center hover:bg-black/80"
					>&times;</button>
				</div>
				{#if scanning}
					<div class="text-center py-2">
						<div class="inline-block w-5 h-5 border-2 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin"></div>
						<p class="text-sm text-[var(--color-text-muted)] mt-1">{scanProgress}</p>
					</div>
				{:else if scanProgress}
					<p class="text-xs text-[var(--color-text-muted)] text-center">{scanProgress}</p>
				{/if}
				<button
					onclick={reset}
					class="w-full bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] py-2 rounded-lg text-sm border border-[var(--color-border)] transition-colors"
				>
					Scan next card
				</button>
			{:else}
				<label class="flex flex-col items-center justify-center h-72 border-2 border-dashed border-[var(--color-border)] rounded-lg cursor-pointer hover:border-[var(--color-primary)] transition-colors bg-[var(--color-surface)]">
					<svg class="w-12 h-12 text-[var(--color-text-muted)] mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
						<path stroke-linecap="round" stroke-linejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
					</svg>
					<p class="text-[var(--color-text-muted)] font-medium">Upload card photo</p>
					<p class="text-xs text-[var(--color-text-muted)] mt-1">Automatically reads set code + number</p>
					<input type="file" accept="image/*" capture="environment" onchange={onFileSelect} class="hidden" />
				</label>
			{/if}

			<!-- Added Cards Log -->
			{#if addedCards.length > 0}
				<div class="bg-green-900/20 border border-green-800 rounded-lg p-3">
					<p class="text-xs text-green-400 font-semibold mb-1">{addedCards.length} added</p>
					{#each addedCards as card}
						<p class="text-xs text-green-300 truncate">{card.name}</p>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Right: Results or Manual Search -->
		<div class="space-y-4">
			{#if results.length > 0 && !scanFailed}
				<!-- Auto-detected results -->
				<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-4">
					<h2 class="text-sm font-semibold mb-3">
						{matchType === 'exact' ? 'Card found!' : `${results.length} results`}
					</h2>
					<div class="space-y-2">
						{#each results as card}
							{@const imgSrc = getImageSrc(card)}
							{@const isAdded = addedCards.some((a) => a.id === card.id)}
							<div class="flex items-center gap-4 p-3 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
								{#if imgSrc}
									<CardPreview src={imgSrc} alt={card.name as string} scale={2}>
										<img src={imgSrc} alt={card.name as string} class="w-16 h-22 object-cover rounded" loading="lazy" />
									</CardPreview>
								{:else}
									<div class="w-16 h-22 bg-[var(--color-surface)] rounded"></div>
								{/if}
								<div class="flex-1 min-w-0">
									<p class="font-semibold text-lg">{card.name}</p>
									<p class="text-sm text-[var(--color-text-muted)]">
										{card.set_name} ({(card.set_code as string).toUpperCase()}) #{card.collector_number}
									</p>
									<p class="text-[var(--color-accent)] font-medium mt-1">{formatPrice(card.price_eur as number | null)}</p>
								</div>
								{#if isAdded}
									<span class="text-green-400 font-medium px-4">Added!</span>
								{:else}
									<button
										onclick={() => addToCollection(card.id as string, card.name as string)}
										disabled={adding === card.id}
										class="bg-green-600 hover:bg-green-700 px-6 py-2.5 rounded-lg font-medium transition-colors disabled:opacity-50"
									>
										{adding === card.id ? '...' : 'Add'}
									</button>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{:else if scanFailed || (imagePreview && !scanning && results.length === 0)}
				<!-- Manual fallback -->
				<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-4 space-y-3">
					<p class="text-sm text-[var(--color-text-muted)]">
						Could not identify card automatically. Search manually:
					</p>
					<div class="flex gap-2 text-sm">
						<button
							onclick={() => searchMode = 'set'}
							class="px-3 py-1 rounded-lg border transition-colors {searchMode === 'set' ? 'bg-[var(--color-primary)] border-[var(--color-primary)] text-white' : 'bg-[var(--color-bg)] border-[var(--color-border)]'}"
						>
							Set + Number
						</button>
						<button
							onclick={() => searchMode = 'name'}
							class="px-3 py-1 rounded-lg border transition-colors {searchMode === 'name' ? 'bg-[var(--color-primary)] border-[var(--color-primary)] text-white' : 'bg-[var(--color-bg)] border-[var(--color-border)]'}"
						>
							Name
						</button>
					</div>

					{#if searchMode === 'set'}
						<form onsubmit={(e) => { e.preventDefault(); manualSearch(); }} class="flex gap-2 items-end">
							<div>
								<label for="set-code" class="block text-xs text-[var(--color-text-muted)] mb-1">Set Code</label>
								<input id="set-code" type="text" bind:value={setCode} placeholder="e.g. tmt"
									class="w-24 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg px-3 py-2 uppercase focus:outline-none focus:border-[var(--color-primary)]" />
							</div>
							<div>
								<label for="col-num" class="block text-xs text-[var(--color-text-muted)] mb-1">Number</label>
								<input id="col-num" type="text" bind:value={collectorNumber} placeholder="e.g. 47"
									class="w-24 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg px-3 py-2 focus:outline-none focus:border-[var(--color-primary)]" />
							</div>
							<button type="submit" class="bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] px-4 py-2 rounded-lg transition-colors">Search</button>
						</form>
					{:else}
						<form onsubmit={(e) => { e.preventDefault(); manualSearch(); }} class="flex gap-2">
							<input type="text" bind:value={searchQuery} placeholder="English card name..."
								class="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg px-4 py-2 focus:outline-none focus:border-[var(--color-primary)]" />
							<button type="submit" class="bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] px-4 py-2 rounded-lg transition-colors">Search</button>
						</form>
					{/if}

					{#if detectedText}
						<details>
							<summary class="text-xs text-[var(--color-text-muted)] cursor-pointer">OCR debug</summary>
							<pre class="text-xs text-[var(--color-text-muted)] mt-1 whitespace-pre-wrap bg-[var(--color-bg)] rounded p-2">{detectedText}</pre>
						</details>
					{/if}
				</div>

				<!-- Manual search results -->
				{#if results.length > 0 && scanFailed}
					<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-4">
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
					</div>
				{/if}
			{:else if !imagePreview}
				<div class="flex items-center justify-center h-72 text-[var(--color-text-muted)]">
					<p>Upload a card photo to get started</p>
				</div>
			{/if}
		</div>
	</div>
</div>
