<script lang="ts">
	import type { PageData } from './$types';
	import { formatPrice } from '$lib/utils';
	import CardPreview from '$lib/components/CardPreview.svelte';
	import { onMount } from 'svelte';

	let { data }: { data: PageData } = $props();
	let loggedIn = $derived(!!data.user);

	// State
	let imagePreview = $state('');
	let scanning = $state(false);
	let scanProgress = $state('');
	let detectedCards = $state<Array<{
		index: number;
		croppedUrl: string;
		bottomUrl: string;
		ocrText: string;
		setCode: string;
		collectorNumber: string;
		results: Array<Record<string, unknown>>;
		matchType: string;
		status: 'scanning' | 'found' | 'not_found';
		foil: boolean;
	}>>([]);
	let debugCanvasUrl = $state('');
	let adding = $state<string | null>(null);
	let addedCards = $state<Array<{ id: string; name: string }>>([]);
	let selectedCards = $state<Set<number>>(new Set());
	let importing = $state(false);

	// Manual search fallback per card
	let manualSetCode = $state('');
	let manualNumber = $state('');
	let manualQuery = $state('');
	let manualMode = $state<'set' | 'name'>('set');
	let manualResults = $state<Array<Record<string, unknown>>>([]);
	let manualCardIndex = $state<number | null>(null);

	let cvReady = $state(false);
	let cvLoading = $state(false);

	// Load OpenCV.js
	async function loadOpenCV(): Promise<void> {
		if ((window as any).cv?.Mat) { cvReady = true; return; }
		if (cvLoading) return;
		cvLoading = true;

		return new Promise((resolve, reject) => {
			const script = document.createElement('script');
			script.src = 'https://docs.opencv.org/4.9.0/opencv.js';
			script.async = true;
			script.onload = () => {
				const checkCv = () => {
					if ((window as any).cv?.Mat) {
						cvReady = true;
						resolve();
					} else {
						setTimeout(checkCv, 100);
					}
				};
				checkCv();
			};
			script.onerror = () => reject(new Error('Failed to load OpenCV.js'));
			document.head.appendChild(script);
		});
	}

	let tesseractWorker: any = null;

	async function getTesseractWorker() {
		if (tesseractWorker) return tesseractWorker;
		const Tesseract = await import('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js');
		const createWorker = Tesseract.createWorker || Tesseract.default?.createWorker;
		if (!createWorker) throw new Error('Failed to load Tesseract.js');
		tesseractWorker = await createWorker('eng');
		// Restrict character set to what appears on MTG cards
		// Prevents misreads like 1→), •→«, etc.
		await tesseractWorker.setParameters({
			tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .*#/&',
			tessedit_pageseg_mode: '6' // Assume single block of text
		});
		return tesseractWorker;
	}

	function onFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		if (input.files?.[0]) {
			const file = input.files[0];
			imagePreview = URL.createObjectURL(file);
			detectedCards = [];
			debugCanvasUrl = '';
			manualResults = [];
			manualCardIndex = null;
			processImage(file);
		}
	}

	async function processImage(file: File) {
		scanning = true;
		scanProgress = 'Loading OpenCV...';

		try {
			await loadOpenCV();
			const cv = (window as any).cv;

			scanProgress = 'Detecting cards...';

			// Load image into canvas
			const img = await loadImage(file);
			const canvas = document.createElement('canvas');
			canvas.width = img.width;
			canvas.height = img.height;
			const ctx = canvas.getContext('2d')!;
			ctx.drawImage(img, 0, 0);

			// OpenCV processing
			const src = cv.imread(canvas);
			const gray = new cv.Mat();

			cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

			// Try multiple Canny threshold pairs to handle different card/background combos
			const cannyParams = [
				{ blur: 5, low: 30, high: 100 },   // Sensitive (borderless, low contrast)
				{ blur: 5, low: 50, high: 150 },   // Standard
				{ blur: 3, low: 75, high: 200 },   // Sharp edges (high contrast)
			];

			let allCandidates: Array<{ corners: any; area: number; rect: { x: number; y: number; width: number; height: number } }> = [];
			const minArea = (img.width * img.height) * 0.015; // 1.5% of image
			const maxArea = (img.width * img.height) * 0.5;   // Max 50%
			const seenRects = new Set<string>();

			for (const params of cannyParams) {
				const blurMat = new cv.Mat();
				const edgeMat = new cv.Mat();
				cv.GaussianBlur(gray, blurMat, new cv.Size(params.blur, params.blur), 0);
				cv.Canny(blurMat, edgeMat, params.low, params.high);

				const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
				cv.dilate(edgeMat, edgeMat, kernel);

				const conts = new cv.MatVector();
				const hier = new cv.Mat();
				cv.findContours(edgeMat, conts, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

				for (let i = 0; i < conts.size(); i++) {
					const contour = conts.get(i);
					const area = cv.contourArea(contour);
					if (area < minArea || area > maxArea) continue;

					const perimeter = cv.arcLength(contour, true);
					const approx = new cv.Mat();
					cv.approxPolyDP(contour, approx, 0.02 * perimeter, true);

					if (approx.rows === 4) {
						const rect = cv.boundingRect(approx);
						const aspect = Math.min(rect.width, rect.height) / Math.max(rect.width, rect.height);
						if (aspect > 0.55 && aspect < 0.85) {
							const key = `${Math.round(rect.x / 20)}_${Math.round(rect.y / 20)}_${Math.round(rect.width / 20)}`;
							if (!seenRects.has(key)) {
								seenRects.add(key);
								allCandidates.push({ corners: approx.clone(), area, rect });
							}
						}
					}
					approx.delete();
				}

				blurMat.delete(); edgeMat.delete(); kernel.delete();
				conts.delete(); hier.delete();
			}

			// Filter out contours contained within larger ones (text boxes inside cards)
			allCandidates.sort((a, b) => b.area - a.area);
			const cardContours: typeof allCandidates = [];
			for (const candidate of allCandidates) {
				const r = candidate.rect;
				const isInside = cardContours.some(card => {
					const c = card.rect;
					// Check if candidate center is inside an existing larger card
					const cx = r.x + r.width / 2;
					const cy = r.y + r.height / 2;
					return cx > c.x && cx < c.x + c.width && cy > c.y && cy < c.y + c.height;
				});
				if (!isInside) {
					cardContours.push(candidate);
				}
			}

			// Debug: draw detected rectangles on image
			const debugMat = src.clone();
			for (let i = 0; i < cardContours.length; i++) {
				const pts = cardContours[i].corners;
				for (let j = 0; j < 4; j++) {
					const p1 = new cv.Point(pts.data32S[j * 2], pts.data32S[j * 2 + 1]);
					const p2 = new cv.Point(pts.data32S[((j + 1) % 4) * 2], pts.data32S[((j + 1) % 4) * 2 + 1]);
					cv.line(debugMat, p1, p2, new cv.Scalar(0, 255, 0, 255), 3);
				}
				// Label
				const labelPt = new cv.Point(pts.data32S[0], pts.data32S[1] - 10);
				cv.putText(debugMat, `Card ${i + 1}`, labelPt, cv.FONT_HERSHEY_SIMPLEX, 1.5, new cv.Scalar(0, 255, 0, 255), 3);
			}

			const debugCanvas = document.createElement('canvas');
			cv.imshow(debugCanvas, debugMat);
			debugCanvasUrl = debugCanvas.toDataURL();
			debugMat.delete();

			if (cardContours.length === 0) {
				scanProgress = 'No cards detected. Try a clearer photo.';
				scanning = false;
				src.delete(); gray.delete();
				return;
			}

			scanProgress = `Found ${cardContours.length} card(s). Reading...`;

			// Process each detected card
			const cards: typeof detectedCards = [];

			for (let i = 0; i < cardContours.length; i++) {
				const pts = cardContours[i].corners;

				// Order corners: top-left, top-right, bottom-right, bottom-left
				const points: Array<[number, number]> = [];
				for (let j = 0; j < 4; j++) {
					points.push([pts.data32S[j * 2], pts.data32S[j * 2 + 1]]);
				}
				let ordered = orderCorners(points);

				// Check if card is landscape (sideways) - rotate to portrait
				const edgeTop = Math.hypot(ordered[1][0] - ordered[0][0], ordered[1][1] - ordered[0][1]);
				const edgeLeft = Math.hypot(ordered[3][0] - ordered[0][0], ordered[3][1] - ordered[0][1]);
				if (edgeTop > edgeLeft) {
					ordered = [ordered[1], ordered[2], ordered[3], ordered[0]];
				}

				// Expand corners outward by ~3% to ensure the full card is captured
				// (edge detection often finds inner edges, cutting off the border)
				const cx = (ordered[0][0] + ordered[1][0] + ordered[2][0] + ordered[3][0]) / 4;
				const cy = (ordered[0][1] + ordered[1][1] + ordered[2][1] + ordered[3][1]) / 4;
				const pad = 0.05;
				ordered = ordered.map(([x, y]) => [
					Math.max(0, Math.min(img.width - 1, Math.round(x + (x - cx) * pad))),
					Math.max(0, Math.min(img.height - 1, Math.round(y + (y - cy) * pad)))
				]) as Array<[number, number]>;

				// Perspective transform to flatten card
				const cardW = 488;
				const cardH = 680;
				const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, ordered.flat());
				const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, cardW, 0, cardW, cardH, 0, cardH]);
				const M = cv.getPerspectiveTransform(srcPts, dstPts);
				const warped = new cv.Mat();
				cv.warpPerspective(src, warped, M, new cv.Size(cardW, cardH));

				// Get full card image
				const cardCanvas = document.createElement('canvas');
				cv.imshow(cardCanvas, warped);
				const croppedUrl = cardCanvas.toDataURL();

				// Crop bottom 10% left half for collector info (right side has copyright)
				const bottomY = Math.floor(cardH * 0.90);
				const bottomH = cardH - bottomY;
				const roiW = Math.floor(cardW * 0.5);
				const bottomRoi = warped.roi(new cv.Rect(0, bottomY, roiW, bottomH));

				// Convert to grayscale, scale up 6x, and sharpen for better OCR
				const grayBottom = new cv.Mat();
				cv.cvtColor(bottomRoi, grayBottom, cv.COLOR_RGBA2GRAY);
				const upscaled = new cv.Mat();
				cv.resize(grayBottom, upscaled, new cv.Size(roiW * 6, bottomH * 6), 0, 0, cv.INTER_CUBIC);
				// Unsharp mask: subtract blurred version to enhance edges
				const blurredBottom = new cv.Mat();
				cv.GaussianBlur(upscaled, blurredBottom, new cv.Size(0, 0), 3);
				const scaled = new cv.Mat();
				cv.addWeighted(upscaled, 1.5, blurredBottom, -0.5, 0, scaled);
				grayBottom.delete(); upscaled.delete(); blurredBottom.delete();

				const bottomCanvas = document.createElement('canvas');
				cv.imshow(bottomCanvas, scaled);
				const bottomUrl = bottomCanvas.toDataURL();

				cards.push({
					index: i,
					croppedUrl,
					bottomUrl,
					ocrText: '',
					setCode: '',
					collectorNumber: '',
					results: [],
					matchType: '',
					status: 'scanning',
					foil: false
				});

				// Cleanup card-specific mats
				srcPts.delete(); dstPts.delete(); M.delete(); warped.delete();
				bottomRoi.delete(); scaled.delete();
				pts.delete();
			}

			detectedCards = cards;

			// Cleanup OpenCV mats
			src.delete(); gray.delete();

			// OCR each card
			scanProgress = 'Running OCR...';
			const worker = await getTesseractWorker();

			for (let i = 0; i < detectedCards.length; i++) {
				scanProgress = `Reading card ${i + 1} of ${detectedCards.length}...`;
				const card = detectedCards[i];

				try {
					const result = await worker.recognize(card.bottomUrl);
					const text = result.data.text;
					card.ocrText = text;

					// Parse collector info using anchor-based matching.
					const langs = 'EN|DE|FR|IT|ES|JA|PT|RU|ZH|KO';
					const parsed = parseCollectorInfo(text, langs);
					card.setCode = parsed.setCode;
					card.collectorNumber = parsed.collectorNumber;

					// Foil detection: combine OCR text hint with pixel analysis
					const foilFromPixels = detectFoilFromWords(result.data.words, card.bottomUrl, parsed.setCode, langs);
					card.foil = parsed.foilFromText || foilFromPixels;

					if (card.setCode && card.collectorNumber) {
						const res = await fetch('/scan', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ setCode: card.setCode, collectorNumber: card.collectorNumber })
						});
						const data = await res.json();
						card.results = data.results;
						card.matchType = data.matchType || 'none';
						card.status = card.results.length > 0 ? 'found' : 'not_found';
					} else {
						card.status = 'not_found';
					}
				} catch {
					card.status = 'not_found';
				}

				detectedCards = [...detectedCards]; // trigger reactivity
			}

			scanProgress = `Done! ${detectedCards.filter((c) => c.status === 'found').length} of ${detectedCards.length} identified.`;
		} catch (err) {
			scanProgress = `Error: ${(err as Error).message}`;
		} finally {
			scanning = false;
		}
	}

	function loadImage(file: File): Promise<HTMLImageElement> {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => resolve(img);
			img.onerror = reject;
			img.src = URL.createObjectURL(file);
		});
	}

	// Fix common OCR misreads of digits
	function fixOcrDigits(s: string): string {
		return s
			.replace(/[JjIil|!]/g, '1')  // J, I, l, |, ! → 1
			.replace(/[Oo]/g, '0')        // O, o → 0
			.replace(/[Ss]/g, '5')        // S, s → 5
			.replace(/[Bb]/g, '8')        // B → 8
			.replace(/[Zz]/g, '2')        // Z → 2
			.replace(/[)]/g, '1')         // ) → 1
			.replace(/[^0-9]/g, '');       // remove anything else
	}

	function stripLeadingZeros(s: string): string {
		const stripped = s.replace(/^0+/, '');
		return stripped || '0';
	}

	function parseCollectorInfo(text: string, langs: string): { setCode: string; collectorNumber: string; foilFromText: boolean } {
		const result = { setCode: '', collectorNumber: '', foilFromText: false };

		// Step 1: Find anchor — <SET 3-letter> followed by <LANG 2-letter> within a few chars
		const anchor = new RegExp(`([A-Z]{3})\\s*(\\S?)\\s*(?:${langs})\\b`, 'i');
		const anchorMatch = text.match(anchor);

		if (anchorMatch) {
			result.setCode = anchorMatch[1].toLowerCase();

			// Check separator character for foil hint
			const sep = anchorMatch[2] || '';
			result.foilFromText = /[*#&xX]/.test(sep);

			// Step 2: Extract collector number from text BEFORE the set code
			const before = text.substring(0, anchorMatch.index);

			// Handle fraction format first (Era 3): "010/277"
			const fractionMatch = before.match(/([\dOoIilJjBbSsZz]{1,4})\/([\dOoIilJjBbSsZz]{1,4})/);
			if (fractionMatch) {
				result.collectorNumber = stripLeadingZeros(fixOcrDigits(fractionMatch[1]));
			} else {
				// Find digit sequences. Then check if a single char follows (possibly
				// separated by space) that's a common OCR misread of a digit.
				// e.g. "024 J" → J is misread 1, so collector number is 0241
				const allDigits = [...before.matchAll(/\d{1,4}/g)];
				if (allDigits.length > 0) {
					const lastMatch = allDigits[allDigits.length - 1];
					let raw = lastMatch[0];
					// Check char(s) right after the digits (skip spaces)
					const afterIdx = (lastMatch.index ?? 0) + raw.length;
					const after = before.substring(afterIdx).replace(/^\s+/, '');
					// If a single OCR-digit-like char follows before non-digit text
					if (after.length > 0 && /^[JjIil|!)Oo](?:\s|$)/.test(after)) {
						raw += after[0];
					}
					const fixed = fixOcrDigits(raw);
					if (fixed.length > 0 && fixed.length <= 4) {
						result.collectorNumber = stripLeadingZeros(fixed);
					}
				}
			}
		}

		// Fallback: any 3-letter uppercase + any number
		if (!result.setCode) {
			const setMatch = text.match(/\b([A-Z]{3})\b/);
			if (setMatch) result.setCode = setMatch[1].toLowerCase();
			const fractionMatch = text.match(/(\d{1,4})\/\d{1,4}/);
			if (fractionMatch) {
				result.collectorNumber = stripLeadingZeros(fractionMatch[1]);
			} else {
				const numMatch = text.match(/(\d{1,4})/);
				if (numMatch) result.collectorNumber = stripLeadingZeros(numMatch[1]);
			}
		}

		return result;
	}

	function detectFoilFromWords(words: any[], bottomUrl: string, setCode: string, langs: string): boolean {
		if (!setCode || !words?.length) return false;

		const langList = langs.split('|');
		const setUpper = setCode.toUpperCase();

		// Find the SET word and LANG word in Tesseract's word list
		let setWord: any = null;
		let langWord: any = null;
		for (const w of words) {
			const t = w.text.toUpperCase().replace(/[^A-Z]/g, '');
			if (t === setUpper) setWord = w;
			if (langList.includes(t) && setWord) { langWord = w; break; }
		}

		if (!setWord || !langWord) return false;

		// Get bounding boxes — the separator is between SET's right edge and LANG's left edge
		const sepX1 = setWord.bbox.x1;  // right edge of SET
		const sepX2 = langWord.bbox.x0; // left edge of LANG
		const sepY0 = Math.min(setWord.bbox.y0, langWord.bbox.y0);
		const sepY1 = Math.max(setWord.bbox.y1, langWord.bbox.y1);
		const sepW = sepX2 - sepX1;
		const sepH = sepY1 - sepY0;

		if (sepW < 3 || sepH < 3) return false;

		// Draw the OCR image onto a canvas to read pixels
		const img = new Image();
		img.src = bottomUrl;

		try {
			const canvas = document.createElement('canvas');
			canvas.width = img.naturalWidth || img.width;
			canvas.height = img.naturalHeight || img.height;
			const ctx = canvas.getContext('2d');
			if (!ctx) return false;
			ctx.drawImage(img, 0, 0);

			// Read the separator region pixels
			const imageData = ctx.getImageData(sepX1, sepY0, sepW, sepH);
			const pixels = imageData.data;

			// Count bright pixels (the symbol is light text on dark background)
			let brightPixels = 0;
			const totalPixels = sepW * sepH;
			for (let i = 0; i < pixels.length; i += 4) {
				const brightness = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
				if (brightness > 140) brightPixels++;
			}

			const brightRatio = brightPixels / totalPixels;
			// Star ★ fills ~15-30% of its bounding box, dot • fills ~5-12%
			return brightRatio > 0.14;
		} catch {
			return false;
		}
	}

	function orderCorners(pts: Array<[number, number]>): Array<[number, number]> {
		// Sort by sum (x+y) to find TL and BR
		const sorted = [...pts].sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
		const tl = sorted[0];
		const br = sorted[3];
		// Sort by diff (x-y) to find TR and BL
		const sorted2 = [...pts].sort((a, b) => (a[0] - a[1]) - (b[0] - b[1]));
		const bl = sorted2[0];
		const tr = sorted2[3];
		return [tl, tr, br, bl];
	}

	async function addToCollection(cardId: string, cardName: string, foil: boolean = false) {
		adding = cardId;
		await fetch('/collection', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ cardId, quantity: 1, condition: 'near_mint', foil })
		});
		adding = null;
		addedCards = [...addedCards, { id: cardId, name: cardName }];
	}

	function openManualSearch(cardIndex: number) {
		manualCardIndex = cardIndex;
		const card = detectedCards[cardIndex];
		manualSetCode = card.setCode;
		manualNumber = card.collectorNumber;
		manualQuery = '';
		manualResults = [];
	}

	async function doManualSearch() {
		if (manualMode === 'set') {
			if (!manualSetCode.trim() || !manualNumber.trim()) return;
			const res = await fetch('/scan', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ setCode: manualSetCode.trim().toLowerCase(), collectorNumber: manualNumber.trim() })
			});
			const data = await res.json();
			manualResults = data.results;
		} else {
			if (manualQuery.trim().length < 2) return;
			const res = await fetch('/scan', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ query: manualQuery.trim() })
			});
			const data = await res.json();
			manualResults = data.results;
		}
	}

	function toggleSelect(idx: number) {
		const next = new Set(selectedCards);
		if (next.has(idx)) next.delete(idx);
		else next.add(idx);
		selectedCards = next;
	}

	function selectAllIdentified() {
		const next = new Set(selectedCards);
		for (let i = 0; i < detectedCards.length; i++) {
			const card = detectedCards[i];
			if (card.status === 'found' && card.results.length > 0) {
				const firstResult = card.results[0];
				if (!addedCards.some(a => a.id === firstResult.id)) {
					next.add(i);
				}
			}
		}
		selectedCards = next;
	}

	async function importAllSelected() {
		importing = true;
		for (const idx of selectedCards) {
			const card = detectedCards[idx];
			if (card.status === 'found' && card.results.length > 0) {
				const result = card.results[0];
				const id = result.id as string;
				const name = result.name as string;
				if (!addedCards.some(a => a.id === id)) {
					await addToCollection(id, name, card.foil);
				}
			}
		}
		selectedCards = new Set();
		importing = false;
	}

	function reset() {
		imagePreview = '';
		detectedCards = [];
		debugCanvasUrl = '';
		scanProgress = '';
		manualResults = [];
		manualCardIndex = null;
		selectedCards = new Set();
	}

	let copied = $state(false);

	function getMoxfieldText(): string {
		const lines: string[] = [];
		for (const card of detectedCards) {
			if (card.status === 'found' && card.results.length > 0) {
				const r = card.results[0];
				const rawName = r.name as string;
				const parts = rawName.split(' // ');
				const name = parts.length === 2 && parts[0] === parts[1] ? parts[0] : rawName;
				const set = (r.set_code as string).toUpperCase();
				const num = r.collector_number as string;
				const foilTag = card.foil ? ' *F*' : '';
				lines.push(`1 ${name} (${set}) ${num}${foilTag}`);
			}
		}
		return lines.join('\n');
	}

	async function copyMoxfieldText() {
		const text = getMoxfieldText();
		await navigator.clipboard.writeText(text);
		copied = true;
		setTimeout(() => copied = false, 2000);
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
		{#if !loggedIn}
			<p class="text-sm text-[var(--color-text-muted)]">
				<a href="/login" class="text-[var(--color-primary)] hover:underline">Sign in</a> to add scanned cards to your collection
			</p>
		{/if}
	</div>

	<!-- Upload -->
	{#if !imagePreview}
		<label class="flex flex-col items-center justify-center h-48 border-2 border-dashed border-[var(--color-border)] rounded-lg cursor-pointer hover:border-[var(--color-primary)] transition-colors bg-[var(--color-surface)]">
			<svg class="w-12 h-12 text-[var(--color-text-muted)] mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
				<path stroke-linecap="round" stroke-linejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
			</svg>
			<p class="text-[var(--color-text-muted)] font-medium">Upload photo of card(s)</p>
			<p class="text-xs text-[var(--color-text-muted)] mt-1">Detects multiple cards in one image</p>
			<input type="file" accept="image/*" capture="environment" onchange={onFileSelect} class="hidden" />
		</label>
	{/if}

	<!-- Scanning Status -->
	{#if scanning}
		<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-4 flex items-center gap-3">
			<div class="w-5 h-5 border-2 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin"></div>
			<span class="text-sm">{scanProgress}</span>
		</div>
	{:else if scanProgress && imagePreview}
		<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-3 text-sm text-[var(--color-text-muted)]">
			{scanProgress}
		</div>
	{/if}

	<!-- Detected Cards -->
	{#if detectedCards.length > 0}
		{@const identifiedCount = detectedCards.filter(c => c.status === 'found' && c.results.length > 0 && !addedCards.some(a => a.id === c.results[0].id)).length}
		{@const hasIdentified = detectedCards.some(c => c.status === 'found' && c.results.length > 0)}
		{#if !scanning && (identifiedCount > 0 || hasIdentified)}
			<div class="flex gap-3 items-center flex-wrap">
				{#if loggedIn && identifiedCount > 0}
					<button onclick={selectAllIdentified}
						class="bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] border border-[var(--color-border)] px-4 py-2 rounded-lg text-sm transition-colors">
						Select all identified ({identifiedCount})
					</button>
					{#if selectedCards.size > 0}
						<button onclick={importAllSelected}
							disabled={importing}
							class="bg-green-600 hover:bg-green-700 px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50">
							{importing ? 'Importing...' : `Import ${selectedCards.size} selected`}
						</button>
						<button onclick={() => selectedCards = new Set()}
							class="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
							Clear selection
						</button>
					{/if}
				{/if}
				{#if hasIdentified}
					<button onclick={copyMoxfieldText}
						class="bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] border border-[var(--color-border)] px-4 py-2 rounded-lg text-sm transition-colors flex items-center gap-2">
						{#if copied}
							<svg class="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>
							Copied!
						{:else}
							<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
							Copy for Moxfield
						{/if}
					</button>
				{/if}
			</div>
		{/if}
		<div class="space-y-4">
			{#each detectedCards as card, idx}
				<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-4 {selectedCards.has(idx) ? 'ring-2 ring-green-500/50' : ''}">
					<div class="flex gap-4">
						<!-- Selection checkbox for identified cards -->
						{#if loggedIn && card.status === 'found' && card.results.length > 0 && !addedCards.some(a => a.id === card.results[0].id)}
							<div class="flex-shrink-0 pt-1">
								<input type="checkbox" checked={selectedCards.has(idx)} onchange={() => toggleSelect(idx)}
									class="w-5 h-5 rounded border-[var(--color-border)] accent-green-600 cursor-pointer" />
							</div>
						{/if}
						<!-- Debug: Cropped card + bottom scan -->
						<div class="flex-shrink-0 space-y-2">
							<CardPreview src={card.croppedUrl} alt="Card {idx + 1}" scale={1.5}>
								<img src={card.croppedUrl} alt="Card {idx + 1}" class="w-32 rounded" />
							</CardPreview>
							<div>
								<p class="text-xs text-[var(--color-text-muted)] mb-1">Scanned area:</p>
								<CardPreview src={card.bottomUrl} alt="Bottom scan {idx + 1}" maxWidth={500} maxHeight={120}>
								<img src={card.bottomUrl} alt="Bottom scan {idx + 1}" class="w-32 rounded border border-[var(--color-border)]" />
							</CardPreview>
							</div>
							{#if card.ocrText}
								<p class="text-xs text-[var(--color-text-muted)] font-mono break-all w-32">{card.ocrText.trim()}</p>
							{/if}
						</div>

						<!-- Result -->
						<div class="flex-1">
							<h3 class="text-sm font-semibold mb-2">
								Card {idx + 1}
								<button
									onclick={() => { card.foil = !card.foil; }}
									class="text-xs px-1.5 py-0.5 rounded font-medium ml-1 border transition-colors {card.foil
										? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/30'
										: 'bg-[var(--color-bg)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-text-muted)]'}"
								>
									{card.foil ? 'FOIL' : 'Non-Foil'}
								</button>
								{#if card.setCode || card.collectorNumber}
									<span class="text-[var(--color-text-muted)] font-normal">
										— detected: {card.setCode.toUpperCase()} #{card.collectorNumber}
									</span>
								{/if}
							</h3>

							{#if card.status === 'scanning'}
								<div class="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
									<div class="w-4 h-4 border-2 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin"></div>
									Scanning...
								</div>
							{:else if card.status === 'found' && card.results.length > 0}
								{#each card.results as result}
									{@const imgSrc = getImageSrc(result)}
									{@const isAdded = addedCards.some((a) => a.id === result.id)}
									<div class="flex items-center gap-4 p-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
										{#if imgSrc}
											<CardPreview src={imgSrc} alt={result.name as string} scale={2}>
												<img src={imgSrc} alt={result.name as string} class="w-12 h-16 object-cover rounded" loading="lazy" />
											</CardPreview>
										{/if}
										<div class="flex-1 min-w-0">
											<p class="font-semibold">{result.name}</p>
											<p class="text-xs text-[var(--color-text-muted)]">
												{result.set_name} ({(result.set_code as string).toUpperCase()}) #{result.collector_number}
											</p>
										</div>
										<span class="text-sm text-[var(--color-accent)]">{formatPrice(result.price_eur as number | null, result.price_usd as number | null)}</span>
										{#if loggedIn}
											{#if isAdded}
												<span class="text-green-400 text-sm w-20 text-center">Added!</span>
											{:else}
												<button
													onclick={() => addToCollection(result.id as string, result.name as string, card.foil)}
													disabled={adding === result.id}
													class="bg-green-600 hover:bg-green-700 px-4 py-1.5 rounded-lg text-sm transition-colors disabled:opacity-50"
												>
													{adding === result.id ? '...' : 'Add'}
												</button>
											{/if}
										{/if}
									</div>
								{/each}
							{:else}
								<p class="text-sm text-[var(--color-text-muted)] mb-2">Not identified automatically.</p>
								{#if manualCardIndex === idx}
									<!-- Manual search form -->
									<div class="space-y-2">
										<div class="flex gap-2 text-xs">
											<button onclick={() => manualMode = 'set'}
												class="px-2 py-0.5 rounded border transition-colors {manualMode === 'set' ? 'bg-[var(--color-primary)] border-[var(--color-primary)] text-white' : 'border-[var(--color-border)]'}">
												Set + #
											</button>
											<button onclick={() => manualMode = 'name'}
												class="px-2 py-0.5 rounded border transition-colors {manualMode === 'name' ? 'bg-[var(--color-primary)] border-[var(--color-primary)] text-white' : 'border-[var(--color-border)]'}">
												Name
											</button>
										</div>
										{#if manualMode === 'set'}
											<form onsubmit={(e) => { e.preventDefault(); doManualSearch(); }} class="flex gap-2 items-end">
												<input type="text" bind:value={manualSetCode} placeholder="Set"
													class="w-20 bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-sm uppercase focus:outline-none focus:border-[var(--color-primary)]" />
												<input type="text" bind:value={manualNumber} placeholder="#"
													class="w-20 bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-sm focus:outline-none focus:border-[var(--color-primary)]" />
												<button type="submit" class="bg-[var(--color-primary)] px-3 py-1 rounded text-sm">Search</button>
											</form>
										{:else}
											<form onsubmit={(e) => { e.preventDefault(); doManualSearch(); }} class="flex gap-2">
												<input type="text" bind:value={manualQuery} placeholder="Card name..."
													class="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-sm focus:outline-none focus:border-[var(--color-primary)]" />
												<button type="submit" class="bg-[var(--color-primary)] px-3 py-1 rounded text-sm">Search</button>
											</form>
										{/if}
										{#if manualResults.length > 0}
											<div class="space-y-1 mt-2">
												{#each manualResults as result}
													{@const imgSrc = getImageSrc(result)}
													{@const isAdded = addedCards.some((a) => a.id === result.id)}
													<div class="flex items-center gap-3 p-1.5 rounded hover:bg-[var(--color-surface-hover)]">
														{#if imgSrc}
															<CardPreview src={imgSrc} alt={result.name as string} scale={2}>
																<img src={imgSrc} alt={result.name as string} class="w-8 h-11 object-cover rounded" loading="lazy" />
															</CardPreview>
														{/if}
														<div class="flex-1 min-w-0">
															<p class="text-sm font-medium truncate">{result.name}</p>
															<p class="text-xs text-[var(--color-text-muted)]">{result.set_name} #{result.collector_number}</p>
														</div>
														<span class="text-xs text-[var(--color-accent)]">{formatPrice(result.price_eur as number | null, result.price_usd as number | null)}</span>
														{#if loggedIn}
															{#if isAdded}
																<span class="text-green-400 text-xs">Added!</span>
															{:else}
																<button onclick={() => addToCollection(result.id as string, result.name as string, card.foil)}
																	class="bg-green-600 hover:bg-green-700 px-2 py-0.5 rounded text-xs">Add</button>
															{/if}
														{/if}
													</div>
												{/each}
											</div>
										{/if}
									</div>
								{:else}
									<button onclick={() => openManualSearch(idx)}
										class="text-sm text-[var(--color-primary)] hover:underline">
										Search manually
									</button>
								{/if}
							{/if}
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}

	<!-- Debug: Full image with detection overlay -->
	{#if debugCanvasUrl}
		<details class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)]">
			<summary class="p-4 cursor-pointer text-sm font-semibold">Debug: Card Detection</summary>
			<div class="p-4 pt-0">
				<img src={debugCanvasUrl} alt="Detection debug" class="w-full rounded" />
			</div>
		</details>
	{/if}

	<!-- Added Cards + Actions -->
	{#if addedCards.length > 0}
		<div class="bg-green-900/20 border border-green-800 rounded-lg p-4">
			<p class="text-green-400 font-semibold mb-1">{addedCards.length} card{addedCards.length > 1 ? 's' : ''} added</p>
			{#each addedCards as card}
				<p class="text-sm text-green-300">{card.name}</p>
			{/each}
		</div>
	{/if}

	{#if imagePreview && !scanning}
		<div class="flex gap-3">
			<button onclick={reset}
				class="bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] px-4 py-2 rounded-lg text-sm transition-colors">
				Scan new photo
			</button>
			{#if loggedIn}
				<a href="/collection"
					class="bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] px-4 py-2 rounded-lg text-sm border border-[var(--color-border)] transition-colors">
					Go to collection
				</a>
			{/if}
		</div>
	{/if}
</div>
