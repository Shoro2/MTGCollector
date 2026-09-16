<script lang="ts">
	import type { PageData } from './$types';
	import { type PriceFields } from '$lib/utils';
	import PriceTag from '$lib/components/PriceTag.svelte';
	import CardPreview from '$lib/components/CardPreview.svelte';
	import LiveScanner from '$lib/components/LiveScanner.svelte';
	import { onMount, onDestroy } from 'svelte';
	import { loadOpenCV } from '$lib/scanner/opencv';
	import { getTesseractPool, setPoolParameters, recognizeBatch, recognizeDetailed, terminatePool } from '$lib/scanner/tesseract';
	import { parseCollectorInfo } from '$lib/scanner/parse';
	import { rankNameMatches, realWordCount } from '$lib/scanner/similarity';
	import { resolveCard, nameIdentifies, isStructural, NAME_LIKELY, type FooterReading, type NameCandidate, type PrintingRow, type Finish, type DecisionState } from '$lib/scanner/resolve';
	import { recognizeLines as paddleRecognizeLines } from '$lib/scanner/paddle';
	import { loadImage, orderCorners } from '$lib/scanner/geometry';
	import { detectFoilFromSeparator } from '$lib/scanner/foil';
	import { cropWindowsFromProfiles } from '$lib/scanner/crops';
	import type { QuickRect } from '$lib/scanner/detect';
	import { emptyCells, filterByDimensions, inferGrid } from '$lib/scanner/grid';

	let { data }: { data: PageData } = $props();
	let loggedIn = $derived(!!data.user);

	// State
	let imagePreview = $state('');
	let scanning = $state(false);
	// Monotonic scan token: each processImage() run claims the next value. An
	// older run whose token no longer matches bails at the next checkpoint
	// instead of clobbering the UI for a newer scan (e.g. the user picking a new
	// file mid-scan).
	let scanToken = 0;
	let scanProgress = $state('');
	let detectedCards = $state<Array<{
		index: number;
		croppedUrl: string;
		nameUrl: string;
		bottomUrl: string;
		nameText: string;
		ocrText: string;
		setCode: string;
		collectorNumber: string;
		results: Array<Record<string, unknown>>;
		matchType: string;
		/** found = identity confirmed; likely / conflict wait for one tap; not_found may carry a suggestion. */
		status: 'scanning' | 'found' | 'likely' | 'conflict' | 'not_found';
		/** confirmed = exactly one printing is established; unknown = the user picks from `results`. */
		printingState: DecisionState;
		finish: Finish;
		language: string;
		/** Kept in sync with `finish` for the collection API and the Moxfield text. */
		foil: boolean;
		selectedResultIdx: number;
		/** Evidence collected by the OCR phases; the fusion (resolveCard) turns it into the fields above. */
		nameCandidates: NameCandidate[];
		readings: FooterReading[];
		/** Up to three candidates attached to a not_found card (structural number without name evidence, one digit off) for one-tap acceptance. */
		suggestions: PrintingRow[];
		reasons: string[];
		/** Crops from the 180°-rotated warp when the upside-down retry did not resolve the name (Phase 2b). */
		altNameUrl?: string;
		altBottomUrl?: string;
		altCroppedUrl?: string;
		/** Secondary OCR inputs: name band binarised at NAME_OCR_SCALE_ALT (raw-line pass) and at NAME_OCR_SCALE (binarised single-line pass), collector strip at BOTTOM_OCR_SCALE_ALT. */
		nameUrl2?: string;
		nameUrl3?: string;
		nameUrl4?: string;
		bottomUrl2?: string;
		altNameUrl2?: string;
		altNameUrl3?: string;
		altNameUrl4?: string;
		altBottomUrl2?: string;
	}>>([]);
	let debugCanvasUrl = $state('');
	let debugLog = $state<string[]>([]);
	let scanStartTime = 0;
	let debugLogCopied = $state(false);
	let adding = $state<string | null>(null);
	let addedCards = $state<Array<{ id: string; name: string }>>([]);
	let selectedCards = $state<Set<number>>(new Set());
	let importing = $state(false);
	// Mode selector. 'single' assumes one card in the photo; 'multiple' lets
	// the detector return as many cards as it can find; 'live' streams the
	// device camera and auto-captures when the scene stabilizes (multi-card).
	let scanMode = $state<'single' | 'multiple' | 'live'>('single');
	const expectedCardCount = $derived<number | null>(scanMode === 'single' ? 1 : null);

	// Long edge of the image the detection strategies run on. Card edges don't
	// need a 12-megapixel phone photo — running the six strategies at full
	// resolution took several seconds on a phone — while the perspective warp
	// still samples the full-resolution frame, so OCR quality is unchanged.
	const DETECT_MAX_EDGE = 1600;
	// Base size of the perspective warp every card is flattened to. A card that
	// covers more source pixels than this (a 2x2 phone spread, a card filling a
	// live frame, camera photos) is warped at up to WARP_MAX_SCALE times the base
	// size, so the ~1.5 mm collector line keeps its native pixels instead of
	// being downsampled to ~12 px before OCR. The OCR crops are upscaled by a
	// factor that compensates for the warp scale, so the Tesseract input has the
	// same pixel size (and cost) either way. The UI thumbnails stay at base size.
	const WARP_BASE_W = 488;
	const WARP_BASE_H = 680;
	const WARP_MAX_SCALE = 2;
	// OCR input scale relative to the base warp. Tesseract's LSTM reads a name
	// bar best when the letters are ~30-50 px tall; the old 6x upscale produced
	// ~140 px letters and made the line finder fail on perfectly legible names.
	// Measured on 75 real-photo cards: 41 names read at 6x, 51 at 1.5x, 58 with
	// a second raw-line (PSM 13) pass at 2x; collector strips 18 at 6x, 24 at
	// 4x, 27 with a second pass at 2x. Name passes (ocr-preprocess-experiment):
	// gray PSM 7 at 1.5x reads 49, an Otsu-binarised copy 57, and the union of
	// gray PSM 7 + binarised PSM 7 + binarised PSM 13 at 2x is 68 of 75 (the
	// two gray passes alone: 60).
	const NAME_OCR_SCALE = 1.5;
	const NAME_OCR_SCALE_ALT = 2;
	const BOTTOM_OCR_SCALE = 4;
	const BOTTOM_OCR_SCALE_ALT = 2;
	const NAME_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ',-.";
	const BOTTOM_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .*#/&';

	/** Record a name-search candidate of a card (every pass, accepted or not) as evidence for the fusion. */
	function noteNameCandidate(card: { nameCandidates: NameCandidate[] }, best: { name: string; score: number }, pass: string) {
		if (!best.name || best.score <= 0) return;
		const existing = card.nameCandidates.find((c) => c.name === best.name);
		if (existing) {
			if (best.score > existing.score) {
				existing.score = best.score;
				existing.pass = pass;
			}
		} else {
			card.nameCandidates.push({ name: best.name, score: best.score, pass });
		}
	}

	/** Set most confirmed cards of a scan belong to (at least 3 cards and 60%), else null. */
	function majoritySetOf(cards: Array<{ status: string; printingState: string; results: Array<Record<string, unknown>> }>): string | null {
		const counts = new Map<string, number>();
		let total = 0;
		for (const c of cards) {
			if (c.status !== 'found' || c.printingState !== 'confirmed' || c.results.length !== 1) continue;
			const sc = String(c.results[0].set_code).toLowerCase();
			counts.set(sc, (counts.get(sc) ?? 0) + 1);
			total++;
		}
		const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
		return top && top[1] >= 3 && top[1] >= total * 0.6 ? top[0] : null;
	}

	/** A card the bulk actions may take: identity confirmed and exactly one printing established. */
	function isImportable(card: { status: string; printingState: string; results: Array<Record<string, unknown>> }): boolean {
		return card.status === 'found' && card.results.length > 0 && (card.results.length === 1 || card.printingState === 'confirmed');
	}

	/** Base-size PNG data URL of a warped card canvas for the result list and debug views. */
	function cardThumbnailUrl(canvas: HTMLCanvasElement): string {
		if (canvas.width === WARP_BASE_W && canvas.height === WARP_BASE_H) return canvas.toDataURL();
		const thumb = document.createElement('canvas');
		thumb.width = WARP_BASE_W;
		thumb.height = WARP_BASE_H;
		const ctx = thumb.getContext('2d');
		if (!ctx) return canvas.toDataURL();
		ctx.drawImage(canvas, 0, 0, WARP_BASE_W, WARP_BASE_H);
		return thumb.toDataURL();
	}

	// Manual search fallback per card
	let manualSetCode = $state('');
	let manualNumber = $state('');
	let manualQuery = $state('');
	let manualMode = $state<'set' | 'name'>('set');
	let manualResults = $state<Array<Record<string, unknown>>>([]);
	let manualCardIndex = $state<number | null>(null);

	// Toggle for Google Vision retry on cards Tesseract failed to identify.
	// Persisted in localStorage; only meaningful when the user has stored their
	// own Vision API key in /settings.
	let visionRetryEnabled = $state(true);
	let visionRetriedCount = $state(0);

	onMount(() => {
		try {
			const stored = localStorage.getItem('mtg-scan-vision-retry');
			if (stored !== null) visionRetryEnabled = stored === 'true';
		} catch { /* localStorage unavailable */ }
		try {
			const storedMode = localStorage.getItem('mtg-scan-mode');
			if (storedMode === 'single' || storedMode === 'multiple' || storedMode === 'live') {
				scanMode = storedMode;
			}
		} catch { /* localStorage unavailable */ }
	});

	$effect(() => {
		try {
			localStorage.setItem('mtg-scan-vision-retry', String(visionRetryEnabled));
		} catch { /* localStorage unavailable */ }
	});

	$effect(() => {
		try {
			localStorage.setItem('mtg-scan-mode', scanMode);
		} catch { /* localStorage unavailable */ }
	});

	// Live mode: spin up the Tesseract worker pool while the camera is still
	// being set up, so the first capture doesn't pay the worker spawn +
	// traineddata download (several seconds on a phone) on top of the OCR
	// itself. The pool is torn down in onDestroy as before.
	$effect(() => {
		if (scanMode !== 'live') return;
		getTesseractPool().catch((err) => log(`[live] Tesseract pre-warm failed: ${err}`));
	});

	// Terminate Tesseract workers when leaving the page. Each worker holds
	// ~50 MB of runtime + language data; without this the pool persists until
	// the tab closes even after a single scan.
	onDestroy(() => {
		terminatePool().catch(() => { /* already gone */ });
		if (imagePreview) URL.revokeObjectURL(imagePreview);
	});

	function log(msg: string) {
		const elapsed = ((performance.now() - scanStartTime) / 1000).toFixed(2);
		// Push instead of spread — spread allocates a new array per call
		// and we log ~70+ times per scan.
		debugLog.push(`[+${elapsed}s] ${msg}`);
		debugLog = debugLog;
	}

	async function copyDebugLog() {
		await navigator.clipboard.writeText(debugLog.join('\n'));
		debugLogCopied = true;
		setTimeout(() => debugLogCopied = false, 2000);
	}

	// OpenCV + Tesseract + name/parse helpers come from src/lib/scanner/.

	function onFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		if (input.files?.[0]) {
			const file = input.files[0];
			if (imagePreview) URL.revokeObjectURL(imagePreview);
			imagePreview = URL.createObjectURL(file);
			detectedCards = [];
			debugCanvasUrl = '';
			debugLog = [];
			manualResults = [];
			manualCardIndex = null;
			visionRetriedCount = 0;
			processImage(file);
		}
	}

	async function handleLiveCapture(canvas: HTMLCanvasElement, rects: QuickRect[] = []) {
		// Don't reset detectedCards — captures accumulate. Skip if a previous
		// capture is still being identified (the LiveScanner's busy prop also
		// gates the auto-capture loop, but a manual click can race past it).
		if (scanning) return;
		manualResults = [];
		manualCardIndex = null;
		await processImage(canvas, rects);
	}

	/**
	 * Detect, warp, OCR and identify every card in `source`.
	 * `presetRects` (live mode) are rectangles the preview loop already tracked
	 * as steady on this very frame; when given, the six-strategy detection is
	 * skipped and the cards are warped straight from them.
	 */
	async function processImage(source: File | HTMLCanvasElement, presetRects: QuickRect[] = []) {
		const myToken = ++scanToken;
		const superseded = () => myToken !== scanToken;
		scanning = true;
		scanStartTime = performance.now();
		scanProgress = 'Loading OpenCV...';

		try {
			await loadOpenCV();
			const cv = (window as any).cv;
			log('OpenCV loaded');
			if (superseded()) return;

			scanProgress = 'Detecting cards...';

			// Load image into canvas. The live-mode path passes the captured
			// frame canvas directly; the upload path goes through loadImage.
			let canvas: HTMLCanvasElement;
			let imgW: number;
			let imgH: number;
			if (source instanceof HTMLCanvasElement) {
				canvas = source;
				imgW = source.width;
				imgH = source.height;
			} else {
				const img = await loadImage(source);
				canvas = document.createElement('canvas');
				canvas.width = img.width;
				canvas.height = img.height;
				const ctx = canvas.getContext('2d')!;
				ctx.drawImage(img, 0, 0);
				imgW = img.width;
				imgH = img.height;
			}
			// Bind the names the rest of this function expects.
			const img = { width: imgW, height: imgH };

			log(`Image loaded: ${img.width}x${img.height} (${(img.width * img.height).toLocaleString()}px)`);
			log(`Mode: ${scanMode}, expectedCardCount: ${expectedCardCount ?? 'unlimited'}`);

			// Detection runs on a copy whose long edge is at most DETECT_MAX_EDGE.
			// Coordinates are mapped back to full resolution before the warp. Live
			// captures with preset rects skip detection, so they skip the copy too.
			const detScale = presetRects.length > 0 ? 1 : Math.min(1, DETECT_MAX_EDGE / Math.max(img.width, img.height));
			const det = {
				width: Math.max(1, Math.round(img.width * detScale)),
				height: Math.max(1, Math.round(img.height * detScale))
			};
			let detCanvas = canvas;
			if (detScale < 1) {
				detCanvas = document.createElement('canvas');
				detCanvas.width = det.width;
				detCanvas.height = det.height;
				detCanvas.getContext('2d')!.drawImage(canvas, 0, 0, det.width, det.height);
				log(`Detection image: ${det.width}x${det.height} (scale ${detScale.toFixed(3)})`);
			}

			// OpenCV processing. `src` is the full-resolution frame used by the
			// perspective warps; `detSrc`/`gray` are the detection-resolution copies.
			const src = cv.imread(canvas);
			const detSrc = detScale < 1 ? cv.imread(detCanvas) : src;
			const gray = new cv.Mat();

			cv.cvtColor(detSrc, gray, cv.COLOR_RGBA2GRAY);

			type CardCandidate = { corners: any; area: number; rect: { x: number; y: number; width: number; height: number }; synthetic?: boolean };
			let allCandidates: CardCandidate[] = [];
			const detArea = det.width * det.height;

			let cardContours: CardCandidate[] = [];
			if (presetRects.length > 0) {
				// Live mode: the preview loop already found and tracked these
				// rectangles on this very frame, so re-running the six full-
				// resolution strategies (1-3 s on a phone) would only rediscover
				// them. Build the candidates directly and go straight to the warp.
				log(`Using ${presetRects.length} rectangle(s) tracked by the live preview, skipping full detection`);
				for (const r of presetRects) {
					const pts = new cv.Mat(4, 1, cv.CV_32SC2);
					for (let k = 0; k < 4; k++) {
						pts.data32S[k * 2] = Math.round(r.corners[k][0]);
						pts.data32S[k * 2 + 1] = Math.round(r.corners[k][1]);
					}
					cardContours.push({ corners: pts, area: r.area, rect: { ...r.rect } });
				}
			} else {
				/** Corner array of a 4x1 CV_32SC2 Mat, for the pure spread-geometry helpers. */
				function matCorners(m: any): Array<[number, number]> {
					return [0, 1, 2, 3].map((k) => [m.data32S[k * 2], m.data32S[k * 2 + 1]] as [number, number]);
				}

				function computeIoU(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): number {
					const x1 = Math.max(a.x, b.x);
					const y1 = Math.max(a.y, b.y);
					const x2 = Math.min(a.x + a.width, b.x + b.width);
					const y2 = Math.min(a.y + a.height, b.y + b.height);
					if (x2 <= x1 || y2 <= y1) return 0;
					const inter = (x2 - x1) * (y2 - y1);
					const union = a.width * a.height + b.width * b.height - inter;
					return inter / union;
				}

				function addCandidate(approx: any, minAspect = 0.5, maxAspect = 0.9) {
					const rect = cv.boundingRect(approx);
					const aspect = Math.min(rect.width, rect.height) / Math.max(rect.width, rect.height);
					if (aspect > minAspect && aspect < maxAspect) {
						const dominated = allCandidates.some(c => computeIoU(rect, c.rect) > 0.5);
						if (!dominated) {
							allCandidates.push({ corners: approx.clone(), area: cv.contourArea(approx), rect });
						}
					}
				}

				// Build a 4-corner Mat from minAreaRect points for the addCandidate function
				function makeCornerMat(rotRect: any): any {
					const vertices = cv.RotatedRect.points(rotRect);
					const pts = new cv.Mat(4, 1, cv.CV_32SC2);
					for (let k = 0; k < 4; k++) {
						pts.data32S[k * 2] = Math.round(vertices[k].x);
						pts.data32S[k * 2 + 1] = Math.round(vertices[k].y);
					}
					return pts;
				}

				// Extract contours from a binary/edge image and add card candidates
				function findCardContours(edgeImg: any, minArea: number, maxArea: number, minAspect = 0.5, maxAspect = 0.9) {
					const conts = new cv.MatVector();
					const hier = new cv.Mat();
					cv.findContours(edgeImg, conts, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

					for (let i = 0; i < conts.size(); i++) {
						const contour = conts.get(i);
						const area = cv.contourArea(contour);
						if (area < minArea || area > maxArea) continue;

						const perimeter = cv.arcLength(contour, true);

						// Try multiple epsilon values to find a 4-sided polygon
						let found = false;
						for (const eps of [0.015, 0.02, 0.03, 0.04]) {
							const approx = new cv.Mat();
							cv.approxPolyDP(contour, approx, eps * perimeter, true);
							if (approx.rows === 4) {
								addCandidate(approx, minAspect, maxAspect);
								found = true;
								approx.delete();
								break;
							}
							approx.delete();
						}

						// Fallback: if polygon has 5-8 sides, use minAreaRect for 4 corners
						if (!found) {
							const approx = new cv.Mat();
							cv.approxPolyDP(contour, approx, 0.02 * perimeter, true);
							if (approx.rows >= 5 && approx.rows <= 8) {
								const rotRect = cv.minAreaRect(contour);
								const cornerMat = makeCornerMat(rotRect);
								addCandidate(cornerMat, minAspect, maxAspect);
								cornerMat.delete();
							}
							approx.delete();
						}
					}

					conts.delete(); hier.delete();
				}

				// === Strategy 1: Canny edge detection with multiple thresholds ===
				const cannyParams = [
					{ blur: 5, low: 30, high: 100 },
					{ blur: 5, low: 50, high: 150 },
					{ blur: 3, low: 75, high: 200 },
				];

				const minArea = detArea * 0.008;
				const maxArea = detArea * 0.5;
				log(`Area thresholds: min=${minArea.toFixed(0)} (0.8%), max=${maxArea.toFixed(0)} (50%)`);

				// Pre-compute blur(gray, 5x5) once and share across strategies 1/2/4/6
				// (all of them used identical parameters). Also cache the two structuring
				// elements reused throughout. cv.threshold / adaptiveThreshold / Canny
				// read their source without modifying it, so one blur5 is safe to share.
				const blur5 = new cv.Mat();
				cv.GaussianBlur(gray, blur5, new cv.Size(5, 5), 0);
				const sepKernel5 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
				const dilateKernel3 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));

				for (const params of cannyParams) {
					const edgeMat = new cv.Mat();
					try {
						if (params.blur === 5) {
							cv.Canny(blur5, edgeMat, params.low, params.high);
						} else {
							const localBlur = new cv.Mat();
							try {
								cv.GaussianBlur(gray, localBlur, new cv.Size(params.blur, params.blur), 0);
								cv.Canny(localBlur, edgeMat, params.low, params.high);
							} finally {
								localBlur.delete();
							}
						}
						cv.dilate(edgeMat, edgeMat, dilateKernel3);
						findCardContours(edgeMat, minArea, maxArea);
						log(`Strategy 1 Canny(blur=${params.blur}, ${params.low}-${params.high}): ${allCandidates.length} total candidates`);
					} finally {
						edgeMat.delete();
					}
				}

				// === Strategy 2: Threshold segmentation for tightly packed cards ===
				const threshMat = new cv.Mat();
				try {
					cv.adaptiveThreshold(blur5, threshMat, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 51, -5);
					cv.erode(threshMat, threshMat, sepKernel5);
					cv.dilate(threshMat, threshMat, sepKernel5);
					findCardContours(threshMat, minArea, maxArea);
					log(`Strategy 2 AdaptiveThreshold(blockSize=51, delta=-5): ${allCandidates.length} total candidates`);
				} finally {
					threshMat.delete();
				}

				// === Strategy 3: Histogram equalization + Canny for low-contrast cards ===
				const eqHist = new cv.Mat();
				const eqBlur = new cv.Mat();
				const eqEdge = new cv.Mat();
				try {
					cv.equalizeHist(gray, eqHist);
					cv.GaussianBlur(eqHist, eqBlur, new cv.Size(5, 5), 0);
					cv.Canny(eqBlur, eqEdge, 40, 120);
					cv.dilate(eqEdge, eqEdge, dilateKernel3);
					findCardContours(eqEdge, minArea, maxArea);
					log(`Strategy 3 HistEq+Canny(40-120): ${allCandidates.length} total candidates`);
				} finally {
					eqHist.delete(); eqBlur.delete(); eqEdge.delete();
				}

				// === Strategy 4: Otsu global threshold ===
				const otsuMat = new cv.Mat();
				try {
					cv.threshold(blur5, otsuMat, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
					cv.erode(otsuMat, otsuMat, sepKernel5);
					cv.dilate(otsuMat, otsuMat, sepKernel5);
					findCardContours(otsuMat, minArea, maxArea);
					log(`Strategy 4 Otsu: ${allCandidates.length} total candidates`);
				} finally {
					otsuMat.delete();
				}

				// === Strategy 5: Color saturation mask ===
				// Cards have colored frames/art that are more saturated than a plain background.
				// This helps detect light-bordered cards that blend with the background in grayscale.
				// try/finally so a throw mid-pipeline doesn't leak Mats into the WASM heap.
				const rgb = new cv.Mat();
				const hsvMat = new cv.Mat();
				const channels = new cv.MatVector();
				const satThresh = new cv.Mat();
				const satCloseKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15));
				const satSepKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
				try {
					cv.cvtColor(detSrc, rgb, cv.COLOR_RGBA2RGB);
					cv.cvtColor(rgb, hsvMat, cv.COLOR_RGB2HSV);
					cv.split(hsvMat, channels);
					const saturation = channels.get(1);
					cv.threshold(saturation, satThresh, 30, 255, cv.THRESH_BINARY);
					cv.morphologyEx(satThresh, satThresh, cv.MORPH_CLOSE, satCloseKernel);
					cv.erode(satThresh, satThresh, satSepKernel);
					cv.dilate(satThresh, satThresh, satSepKernel);
					findCardContours(satThresh, minArea, maxArea);
					log(`Strategy 5 Saturation(thresh=30): ${allCandidates.length} total candidates`);
					saturation.delete();
				} finally {
					satThresh.delete();
					satCloseKernel.delete();
					satSepKernel.delete();
					channels.delete();
					hsvMat.delete();
					rgb.delete();
				}

				// === Strategy 6: Inverted Otsu for light cards on light backgrounds ===
				// Some cards (lands with light borders) blend with white backgrounds.
				// Inverted threshold can catch them. Reuses the shared blur5 + sepKernel5.
				const invOtsuMat = new cv.Mat();
				try {
					cv.threshold(blur5, invOtsuMat, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
					cv.erode(invOtsuMat, invOtsuMat, sepKernel5);
					cv.dilate(invOtsuMat, invOtsuMat, sepKernel5);
					findCardContours(invOtsuMat, minArea, maxArea);
					log(`Strategy 6 InvertedOtsu: ${allCandidates.length} total candidates`);
				} finally {
					invOtsuMat.delete();
				}

				// Filter out contours contained within larger ones
				allCandidates.sort((a, b) => b.area - a.area);
				for (const candidate of allCandidates) {
					const r = candidate.rect;
					const isInside = cardContours.some(card => {
						const c = card.rect;
						const cx = r.x + r.width / 2;
						const cy = r.y + r.height / 2;
						return cx > c.x && cx < c.x + c.width && cy > c.y && cy < c.y + c.height;
					});
					if (!isInside) {
						cardContours.push(candidate);
					}
				}
				log(`Containment filter: ${allCandidates.length} -> ${cardContours.length} candidates`);

				// === Size consistency filter: remove detections much smaller than median ===
				// This catches text-block false positives (e.g. only the text area of a card detected)
				if (cardContours.length >= 3) {
					const areas = cardContours.map(c => c.area).sort((a, b) => a - b);
					const medianArea = areas[Math.floor(areas.length / 2)];
					const beforeSize = cardContours.length;
					cardContours = cardContours.filter(c => c.area >= medianArea * 0.4);
					log(`Size filter: median=${medianArea.toFixed(0)}, threshold=${(medianArea * 0.4).toFixed(0)}, ${beforeSize} -> ${cardContours.length}`);
				}

				// === Dimension consistency filter (multiple mode) ===
				// In a spread every card has the same size. A candidate whose oriented
				// edge lengths (short and long side of the quad — a tilted card keeps
				// its true size, only its bounding box grows) are far off the median
				// is either a partial card (the contour ran into a neighbour) or two
				// touching cards merged into one card-shaped blob; both would OCR
				// garbage. Drop them; the grid inference below re-creates the cells
				// from the surviving neighbours.
				if (scanMode === 'multiple' && cardContours.length >= 4) {
					const beforeDim = cardContours.length;
					const { kept, dropped, median: medDims } = filterByDimensions(
						cardContours.map((c) => ({ candidate: c, corners: matCorners(c.corners) }))
					);
					cardContours = kept.map((k) => k.candidate);
					// 15%: flat-lay spreads vary a few percent with perspective; a partial
					// card is typically 20%+ short on one side.
					log(`Dimension filter: median ${medDims!.short.toFixed(0)}x${medDims!.long.toFixed(0)} (oriented edges, +-15%), ${beforeDim} -> ${cardContours.length}`);
					for (const d of dropped) log(`  dropped ${d.corners.map(([x, y]) => `(${x},${y})`).join(' ')}`);
				}

				// === Progressive relaxation if expected card count not met ===
				if (expectedCardCount && cardContours.length < expectedCardCount) {
					log(`Progressive relaxation triggered (have ${cardContours.length}, need ${expectedCardCount})`);
					const relaxedMinArea = detArea * 0.004;
					const relaxedMinAspect = 0.4;
					const relaxedMaxAspect = 0.95;

					// Re-run Canny with relaxed params, stopping early if we've
					// already surfaced enough candidates for the expected card count.
					// Reuses the shared blur5 for params.blur === 5.
					for (const params of [{ blur: 5, low: 20, high: 80 }, { blur: 7, low: 30, high: 100 }]) {
						const edgeMat = new cv.Mat();
						try {
							if (params.blur === 5) {
								cv.Canny(blur5, edgeMat, params.low, params.high);
							} else {
								const localBlur = new cv.Mat();
								try {
									cv.GaussianBlur(gray, localBlur, new cv.Size(params.blur, params.blur), 0);
									cv.Canny(localBlur, edgeMat, params.low, params.high);
								} finally {
									localBlur.delete();
								}
							}
							cv.dilate(edgeMat, edgeMat, sepKernel5);
							findCardContours(edgeMat, relaxedMinArea, maxArea, relaxedMinAspect, relaxedMaxAspect);
						} finally {
							edgeMat.delete();
						}

						if (allCandidates.length >= expectedCardCount * 1.5) break;
					}

					// Re-run adaptive threshold with different params (reuses shared blur5).
					const relaxThresh = new cv.Mat();
					try {
						cv.adaptiveThreshold(blur5, relaxThresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 31, -3);
						cv.erode(relaxThresh, relaxThresh, dilateKernel3);
						cv.dilate(relaxThresh, relaxThresh, dilateKernel3);
						findCardContours(relaxThresh, relaxedMinArea, maxArea, relaxedMinAspect, relaxedMaxAspect);
					} finally {
						relaxThresh.delete();
					}

					// Re-filter containment with all new candidates
					allCandidates.sort((a, b) => b.area - a.area);
					cardContours = [];
					for (const candidate of allCandidates) {
						const r = candidate.rect;
						const isInside = cardContours.some(card => {
							const c = card.rect;
							const cx = r.x + r.width / 2;
							const cy = r.y + r.height / 2;
							return cx > c.x && cx < c.x + c.width && cy > c.y && cy < c.y + c.height;
						});
						if (!isInside) {
							cardContours.push(candidate);
						}
					}

					// Apply size filter again after relaxed detection
					if (cardContours.length >= 3) {
						const areas = cardContours.map(c => c.area).sort((a, b) => a - b);
						const medianArea = areas[Math.floor(areas.length / 2)];
						cardContours = cardContours.filter(c => c.area >= medianArea * 0.4);
					}
					log(`After relaxation: ${cardContours.length} candidates`);
				}

				// === Grid inference (multiple mode): fill the empty cells of the lattice ===
				// The detected cards are indexed on a lattice via neighbour links (a
				// tilted or foreshortened spread still indexes correctly), a mapping
				// grid index -> image is fitted (affine, or a homography for a photo
				// taken at an angle), and every unoccupied cell — one row/column
				// beyond the detected extent included — becomes a card only when
				// there is texture inside it. The lattice is a hypothesis: nothing is
				// added when the detected cards do not sit on one.
				if (scanMode === 'multiple' && cardContours.length >= 3) {
					const quads = cardContours.map((c) => ({ corners: matCorners(c.corners) }));
					const grid = inferGrid(quads, det);
					if (!grid) {
						log('Grid inference: no consistent lattice (fewer than 2 rows/columns, or cards off the grid) - nothing added');
					} else {
						log(`Grid hypothesis: ${grid.rows} rows x ${grid.cols} cols, ${grid.mapping} mapping from ${grid.indexing}, max residual ${(grid.residual * 100).toFixed(0)}% of pitch, ${grid.offGrid} off-grid, card covers ${(grid.cellHalf.c * 2).toFixed(2)} x ${(grid.cellHalf.r * 2).toFixed(2)} of the pitch`);
						let added = 0;
						for (const cell of emptyCells(grid, quads, det)) {
							// Blank paper has almost no contrast, a card has plenty: skip empty cells.
							const x1 = Math.max(0, Math.round(cell.rect.x));
							const y1 = Math.max(0, Math.round(cell.rect.y));
							const x2 = Math.min(det.width, Math.round(cell.rect.x + cell.rect.width));
							const y2 = Math.min(det.height, Math.round(cell.rect.y + cell.rect.height));
							if (x2 - x1 < 4 || y2 - y1 < 4) continue;
							const cellRoi = gray.roi(new cv.Rect(x1, y1, x2 - x1, y2 - y1));
							const cellMean = new cv.Mat();
							const cellStd = new cv.Mat();
							cv.meanStdDev(cellRoi, cellMean, cellStd);
							const cellContrast = cellStd.data64F[0];
							cellRoi.delete(); cellMean.delete(); cellStd.delete();
							if (cellContrast < 20) {
								log(`Grid cell (${cell.row},${cell.col}) skipped: contrast ${cellContrast.toFixed(1)} looks empty`);
								continue;
							}
							const corners = new cv.Mat(4, 1, cv.CV_32SC2);
							cell.corners.forEach(([x, y], k) => {
								corners.data32S[k * 2] = Math.round(x);
								corners.data32S[k * 2 + 1] = Math.round(y);
							});
							cardContours.push({
								corners,
								area: cell.rect.width * cell.rect.height,
								rect: { ...cell.rect },
								synthetic: true
							});
							added++;
							log(`Grid cell (${cell.row},${cell.col}) added (contrast ${cellContrast.toFixed(1)})`);
						}
						log(`Grid inference: added ${added} synthetic card(s), now ${cardContours.length} total`);
					}
				}

				blur5.delete(); sepKernel5.delete(); dilateKernel3.delete();
			}

			// Debug: draw detected rectangles on the detection-resolution image.
			// Full-detection candidates are still in detection space here; live
			// preset rects arrive in full-resolution coordinates and are scaled down.
			const contoursInDetSpace = presetRects.length === 0;
			const drawScale = contoursInDetSpace ? 1 : detScale;
			const debugMat = detSrc.clone();
			for (let i = 0; i < cardContours.length; i++) {
				const pts = cardContours[i].corners;
				const px = (k: number) => Math.round(pts.data32S[k] * drawScale);
				for (let j = 0; j < 4; j++) {
					const p1 = new cv.Point(px(j * 2), px(j * 2 + 1));
					const p2 = new cv.Point(px(((j + 1) % 4) * 2), px(((j + 1) % 4) * 2 + 1));
					cv.line(debugMat, p1, p2, new cv.Scalar(0, 255, 0, 255), 3);
				}
				// Label
				const labelPt = new cv.Point(px(0), px(1) - 10);
				cv.putText(debugMat, `Card ${i + 1}`, labelPt, cv.FONT_HERSHEY_SIMPLEX, 1.5, new cv.Scalar(0, 255, 0, 255), 3);
			}

			const debugCanvas = document.createElement('canvas');
			cv.imshow(debugCanvas, debugMat);
			// JPEG: encoding a full-resolution PNG took a noticeable fraction of a
			// second per live capture, and this image is only for eyeballing.
			debugCanvasUrl = debugCanvas.toDataURL('image/jpeg', 0.8);
			debugMat.delete();
			if (detSrc !== src) detSrc.delete();

			// In single-card mode, keep only the most prominent (largest-area)
			// detection so the user doesn't get spurious extra crops from
			// background noise.
			if (scanMode === 'single' && cardContours.length > 1) {
				log(`Single mode: trimming ${cardContours.length} candidates to largest`);
				cardContours.sort((a, b) => b.area - a.area);
				cardContours = cardContours.slice(0, 1);
			}

			// Dispose cloned `corners` Mats for candidates that didn't survive
			// containment / size / single-mode filters. Without this, every
			// rejected candidate leaks a 4-point Mat into the WASM heap — small
			// individually, but additive across repeat scans. Grid-inferred
			// synthetic candidates live only in cardContours (not allCandidates),
			// so they're naturally retained here.
			const keepCorners = new Set(cardContours.map((c) => c.corners));
			for (const cand of allCandidates) {
				if (!keepCorners.has(cand.corners)) cand.corners.delete();
			}
			allCandidates = [];

			if (cardContours.length === 0) {
				log('No cards detected');
				scanProgress = 'No cards detected. Try a clearer photo.';
				scanning = false;
				src.delete(); gray.delete();
				return;
			}

			// Map the surviving candidates from detection space to full resolution
			// so the perspective warp samples the original pixels.
			if (contoursInDetSpace && detScale < 1) {
				const inv = 1 / detScale;
				for (const c of cardContours) {
					for (let k = 0; k < 8; k++) c.corners.data32S[k] = Math.round(c.corners.data32S[k] * inv);
					c.rect = { x: c.rect.x * inv, y: c.rect.y * inv, width: c.rect.width * inv, height: c.rect.height * inv };
					c.area *= inv * inv;
				}
			}

			log(`Detection complete: ${cardContours.length} card(s) found`);
			scanProgress = `Found ${cardContours.length} card(s). Reading...`;

			// Name band + collector strip crops from a warped card Mat, upscaled
			// and sharpened for Tesseract. Shared by the card loop and the
			// upside-down retry in Phase 2b, so both read exactly the same windows.
			function extractOcrCrops(
				warpedMat: any,
				synthetic: boolean,
				label: string
			): { nameUrl: string; nameUrl2: string; nameUrl3: string; nameUrl4: string; bottomUrl: string; bottomUrl2: string; bottomCanvas: HTMLCanvasElement } {
				const cardW = warpedMat.cols as number;
				const cardH = warpedMat.rows as number;

				// Where is the card inside this warp? A loose quad leaves margin, a
				// tight one cuts into the border, a grid-inferred cell may be shifted.
				// Intensity profiles find the inner edges of the black border and the
				// OCR windows are anchored on them (src/lib/scanner/crops.ts); cards
				// without a dark border fall back to the fixed percentages.
				const grayCard = new cv.Mat();
				cv.cvtColor(warpedMat, grayCard, cv.COLOR_RGBA2GRAY);
				const rowMeans = (x0: number, x1: number): number[] => {
					const roi = grayCard.roi(new cv.Rect(x0, 0, x1 - x0, cardH));
					const out = new cv.Mat();
					cv.reduce(roi, out, 1, cv.REDUCE_AVG, cv.CV_32F);
					const arr = Array.from(out.data32F as Float32Array);
					roi.delete(); out.delete();
					return arr;
				};
				const colMeans = (y0: number, y1: number): number[] => {
					const roi = grayCard.roi(new cv.Rect(0, y0, cardW, y1 - y0));
					const out = new cv.Mat();
					cv.reduce(roi, out, 0, cv.REDUCE_AVG, cv.CV_32F);
					const arr = Array.from(out.data32F as Float32Array);
					roi.delete(); out.delete();
					return arr;
				};
				const win = cropWindowsFromProfiles(
					rowMeans(Math.floor(cardW * 0.15), Math.floor(cardW * 0.85)),
					rowMeans(Math.floor(cardW * 0.04), Math.floor(cardW * 0.46)),
					colMeans(Math.floor(cardH * 0.2), Math.floor(cardH * 0.8)),
					cardW,
					cardH,
					synthetic
				);
				grayCard.delete();
				const { nameX, nameY, nameW, nameH } = win;
				log(`${label}: crop windows (${win.source}, edges top=${win.edges.top} bottom=${win.edges.bottom} left=${win.edges.left}) name x=${nameX} y=${nameY} w=${nameW} h=${nameH}`);
				// Gray crop of a window, resized to `factor` x the base warp size (so a
				// 2x warp is scaled by half the factor and the OCR input carries real
				// detail at the same cost); the collector strip gets an unsharp mask.
				// `binarize` applies an Otsu threshold with dark text on white (a
				// light-on-dark name bar is inverted first) — Tesseract reads a clean
				// binary name bar better than the gray one on many phone photos.
				const cropUrl = (x: number, y: number, w: number, h: number, factor: number, sharpen: boolean, binarize = false): { url: string; canvas: HTMLCanvasElement } => {
					const roi = warpedMat.roi(new cv.Rect(x, y, w, h));
					const gray = new cv.Mat();
					cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);
					const f = (factor * WARP_BASE_W) / cardW;
					const scaled = new cv.Mat();
					cv.resize(gray, scaled, new cv.Size(Math.max(1, Math.round(w * f)), Math.max(1, Math.round(h * f))), 0, 0, cv.INTER_CUBIC);
					let out = scaled;
					if (sharpen) {
						const blurred = new cv.Mat();
						cv.GaussianBlur(scaled, blurred, new cv.Size(0, 0), Math.max(1, factor / 2));
						out = new cv.Mat();
						cv.addWeighted(scaled, 1.5, blurred, -0.5, 0, out);
						blurred.delete(); scaled.delete();
					} else if (binarize) {
						const lightOnDark = (cv.mean(scaled)[0] as number) < 110;
						out = new cv.Mat();
						cv.threshold(scaled, out, 0, 255, (lightOnDark ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY) | cv.THRESH_OTSU);
						scaled.delete();
					}
					const canvas = document.createElement('canvas');
					cv.imshow(canvas, out);
					roi.delete(); gray.delete(); out.delete();
					return { url: canvas.toDataURL(), canvas };
				};
				const nameUrl = cropUrl(nameX, nameY, nameW, nameH, NAME_OCR_SCALE, false).url;
				const nameUrl2 = cropUrl(nameX, nameY, nameW, nameH, NAME_OCR_SCALE_ALT, false, true).url;
				const nameUrl3 = cropUrl(nameX, nameY, nameW, nameH, NAME_OCR_SCALE, false, true).url;
				const nameUrl4 = cropUrl(nameX, nameY, nameW, nameH, NAME_OCR_SCALE_ALT, false).url;

				// Collector strip (left half only, the right half has the copyright line).
				const { bottomX, bottomY, bottomW: roiW, bottomH } = win;
				log(`${label}: bottom crop x=${bottomX} y=${bottomY} h=${bottomH} w=${roiW}`);
				const bottom = cropUrl(bottomX, bottomY, roiW, bottomH, BOTTOM_OCR_SCALE, true);
				const bottomUrl2 = cropUrl(bottomX, bottomY, roiW, bottomH, BOTTOM_OCR_SCALE_ALT, true).url;
				return { nameUrl, nameUrl2, nameUrl3, nameUrl4, bottomUrl: bottom.url, bottomUrl2, bottomCanvas: bottom.canvas };
			}

			// Process each detected card
			const cards: typeof detectedCards = [];
			// Canvases kept outside $state so Svelte doesn't try to proxy
			// HTMLCanvasElement instances. `bottomCanvases` feeds pixel-based
			// foil detection in single-card mode; `cardCanvases` (the full-resolution
			// warps) feed the upside-down retry in Phase 2b.
			const bottomCanvases: HTMLCanvasElement[] = [];
			const cardCanvases: HTMLCanvasElement[] = [];

			for (let i = 0; i < cardContours.length; i++) {
				const pts = cardContours[i].corners;
				log(`--- Card ${i + 1} ${cardContours[i].synthetic ? '(synthetic)' : ''} ---`);

				// Order corners: top-left, top-right, bottom-right, bottom-left
				const points: Array<[number, number]> = [];
				for (let j = 0; j < 4; j++) {
					points.push([pts.data32S[j * 2], pts.data32S[j * 2 + 1]]);
				}
				// orderCornersForCard returns [TL, TR, BR, BL] such that TL→TR is
				// always the short edge of the card — this handles arbitrary rotation
				// without a separate landscape→portrait flip step.
				let ordered = orderCorners(points);
				const edgeTop = Math.hypot(ordered[1][0] - ordered[0][0], ordered[1][1] - ordered[0][1]);
				const edgeLeft = Math.hypot(ordered[3][0] - ordered[0][0], ordered[3][1] - ordered[0][1]);
				log(`Card ${i + 1}: corners TL(${ordered[0]}) TR(${ordered[1]}) BR(${ordered[2]}) BL(${ordered[3]}) shortEdge=${edgeTop.toFixed(0)} longEdge=${edgeLeft.toFixed(0)}`);

				// Expand each corner outward to capture the full card including black border.
				// The detected contour is on the inner colored frame — expand 5% to get the black border.
				// Skip for synthetic (grid-inferred) cards — their bounding rect already covers the full card.
				if (!cardContours[i].synthetic) {
					const cardWidth = Math.hypot(ordered[1][0] - ordered[0][0], ordered[1][1] - ordered[0][1]);
					const cardHeight = Math.hypot(ordered[3][0] - ordered[0][0], ordered[3][1] - ordered[0][1]);
					const expandX = cardWidth * 0.05;
					const expandY = cardHeight * 0.05;

					const cx = (ordered[0][0] + ordered[1][0] + ordered[2][0] + ordered[3][0]) / 4;
					const cy = (ordered[0][1] + ordered[1][1] + ordered[2][1] + ordered[3][1]) / 4;
					ordered = ordered.map(([x, y]) => {
						const dx = x - cx;
						const dy = y - cy;
						const dist = Math.hypot(dx, dy);
						if (dist === 0) return [x, y] as [number, number];
						const expand = Math.hypot(
							(dx / dist) * expandX,
							(dy / dist) * expandY
						);
						// Deliberately not clamped to the frame: warpPerspective pads
						// out-of-frame samples with black, so a card that reaches the
						// frame edge (typical for a hand-held live capture) keeps the
						// same ~3.5% margin as any other and the fixed name/collector
						// crop windows below still line up. Clamping made such warps
						// tight on the card and pushed the collector line out of its
						// crop window ("0 of 1 identified").
						return [
							Math.round(x + (dx / dist) * expand),
							Math.round(y + (dy / dist) * expand)
						] as [number, number];
					}) as Array<[number, number]>;
				}

				// Perspective transform to flatten the card, at the quad's native
				// resolution up to WARP_MAX_SCALE x the base size (see WARP_BASE_W).
				const quadLong = (Math.hypot(ordered[3][0] - ordered[0][0], ordered[3][1] - ordered[0][1])
					+ Math.hypot(ordered[2][0] - ordered[1][0], ordered[2][1] - ordered[1][1])) / 2;
				const warpScale = Math.min(WARP_MAX_SCALE, Math.max(1, quadLong / WARP_BASE_H));
				const cardW = Math.round(WARP_BASE_W * warpScale);
				const cardH = Math.round(WARP_BASE_H * warpScale);
				log(`Card ${i + 1}: warp ${cardW}x${cardH} (scale ${warpScale.toFixed(2)}, quad long edge ${quadLong.toFixed(0)} px)`);
				const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, ordered.flat());
				const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, cardW, 0, cardW, cardH, 0, cardH]);
				const M = cv.getPerspectiveTransform(srcPts, dstPts);
				const warped = new cv.Mat();
				cv.warpPerspective(src, warped, M, new cv.Size(cardW, cardH));

				// Full-resolution warp for the OCR crops and the upside-down retry;
				// the result list shows a base-size thumbnail.
				const cardCanvas = document.createElement('canvas');
				cv.imshow(cardCanvas, warped);
				const croppedUrl = cardThumbnailUrl(cardCanvas);
				cardCanvases.push(cardCanvas);

				const { nameUrl, nameUrl2, nameUrl3, nameUrl4, bottomUrl, bottomUrl2, bottomCanvas } = extractOcrCrops(warped, !!cardContours[i].synthetic, `Card ${i + 1}`);
				bottomCanvases.push(bottomCanvas);

				cards.push({
					index: i,
					croppedUrl,
					nameUrl,
					nameUrl2,
					nameUrl3,
					nameUrl4,
					bottomUrl,
					bottomUrl2,
					nameText: '',
					ocrText: '',
					setCode: '',
					collectorNumber: '',
					results: [],
					matchType: '',
					status: 'scanning',
					printingState: 'unknown',
					finish: 'unknown',
					language: '',
					foil: false,
					selectedResultIdx: 0,
					nameCandidates: [],
					readings: [],
					suggestions: [],
					reasons: []
				});

				// Cleanup card-specific mats
				srcPts.delete(); dstPts.delete(); M.delete(); warped.delete();
				pts.delete();
			}

			// Append the freshly-detected cards to whatever's already in the
			// list (live mode pushes successive captures into the same UI).
			// `firstIdx` is the index in `detectedCards` of the first newly
			// added card; all subsequent loops iterate `firstIdx ... end`.
			if (superseded()) return;
			const firstIdx = detectedCards.length;
			detectedCards = [...detectedCards, ...cards];
			const newCount = cards.length;

			// Cleanup OpenCV mats
			src.delete(); gray.delete();

			// === Name-first OCR approach ===
			// Phase 1: OCR name areas with Tesseract in parallel across a worker pool.
			// Sequential recognition was the single biggest wall-clock bottleneck —
			// a 10-card scan spent ~5s here.
			const pool = await getTesseractPool();
			log(`Phase 1: Name OCR (Tesseract PSM 7, ${pool.length} workers in parallel)`);
			await setPoolParameters(pool, {
				tessedit_char_whitelist: NAME_WHITELIST,
				tessedit_pageseg_mode: '7' // single text line
			});

			const nameUrls = detectedCards.slice(firstIdx).map((c) => c.nameUrl);
			const nameTexts = await recognizeBatch(pool, nameUrls, (done, total) => {
				scanProgress = `Reading names ${done}/${total}...`;
			});
			for (let i = 0; i < newCount; i++) {
				detectedCards[firstIdx + i].nameText = nameTexts[i].replace(/[\r\n]+/g, ' ').trim();
				log(`Card ${firstIdx + i + 1} name OCR: "${detectedCards[firstIdx + i].nameText}"`);
			}
			detectedCards = [...detectedCards];

			// Phase 2: Batch-search all names server-side in a single round trip.
			// Previously this was 1+ fetch per card (and a second fetch per word
			// fallback), which dominated wall-clock time at low network latency.
			if (superseded()) return;
			log('Phase 2: Name search in DB (batched)');

			const namesToSearch: Array<{ cardIdx: number; cleanName: string }> = [];
			for (let i = 0; i < newCount; i++) {
				const absIdx = firstIdx + i;
				const card = detectedCards[absIdx];
				if (!card.nameText || card.nameText.length < 2) {
					log(`Card ${absIdx + 1}: name too short or empty, skipping search`);
					continue;
				}
				const cleanName = card.nameText.replace(/^[^A-Za-z]+/, '').trim();
				namesToSearch.push({ cardIdx: absIdx, cleanName });
			}

			scanProgress = `Searching ${namesToSearch.length} name(s)...`;
			let primaryBatch: Array<{ query: string; results: Record<string, unknown>[]; matchType: string }> = [];
			if (namesToSearch.length > 0) {
				try {
					const res = await fetch('/scan', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ queries: namesToSearch.map((n) => n.cleanName) })
					});
					const data = await res.json();
					primaryBatch = Array.isArray(data?.batch) ? data.batch : [];
				} catch (err) {
					log(`Batch name search error: ${err}`);
				}
			}

			// Collect fallback words for cards that didn't match, then batch those too.
			const fallbackWords: Array<{ cardIdx: number; cleanName: string; word: string }> = [];
			for (let k = 0; k < namesToSearch.length; k++) {
				const { cardIdx, cleanName } = namesToSearch[k];
				const card = detectedCards[cardIdx];
				const searchData = primaryBatch[k];
				log(`Card ${cardIdx + 1}: searching "${cleanName}"`);
				if (searchData && searchData.results.length > 0) {
					log(`Card ${cardIdx + 1}: ${searchData.results.length} results (matchType=${searchData.matchType})`);
					const rankedNames = rankNameMatches(searchData.results, cleanName);
					const best = rankedNames[0] ?? { name: '', score: 0 };
					for (const m of rankedNames) noteNameCandidate(card, m, 'primary');
					log(`Card ${cardIdx + 1}: best match "${best.name}" score=${best.score.toFixed(3)} (threshold=0.6)`);
					if (nameIdentifies(best, cleanName)) {
						card.results = searchData.results.filter((r: Record<string, unknown>) => r.name === best.name);
						card.matchType = searchData.matchType;
						log(`Card ${cardIdx + 1}: accepted "${best.name}" -> ${card.results.length} reprints`);
						continue;
					}
					log(`Card ${cardIdx + 1}: score below threshold, rejected`);
				}

				// Queue word fallback — longest 2 words sorted by length.
				const words = cleanName.split(/\s+/).filter((w) => w.length >= 3);
				words.sort((a, b) => b.length - a.length);
				for (const word of words.slice(0, 2)) {
					fallbackWords.push({ cardIdx, cleanName, word });
				}
			}

			if (fallbackWords.length > 0) {
				log(`Phase 2 fallback: ${fallbackWords.length} word queries for ${new Set(fallbackWords.map((f) => f.cardIdx)).size} card(s)`);
				let fallbackBatch: Array<{ query: string; results: Record<string, unknown>[]; matchType: string }> = [];
				try {
					const res = await fetch('/scan', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ queries: fallbackWords.map((f) => f.word) })
					});
					const data = await res.json();
					fallbackBatch = Array.isArray(data?.batch) ? data.batch : [];
				} catch (err) {
					log(`Batch fallback search error: ${err}`);
				}

				// Walk fallback results in order, stopping per-card as soon as one matches.
				for (let k = 0; k < fallbackWords.length; k++) {
					const { cardIdx, cleanName, word } = fallbackWords[k];
					const card = detectedCards[cardIdx];
					if (card.results.length > 0) continue;
					const wData = fallbackBatch[k];
					if (!wData || wData.results.length === 0) {
						log(`Card ${cardIdx + 1}: word "${word}" -> 0 results`);
						continue;
					}
					log(`Card ${cardIdx + 1}: word "${word}" -> ${wData.results.length} results`);
					const rankedNames = rankNameMatches(wData.results, cleanName);
					const best = rankedNames[0] ?? { name: '', score: 0 };
					for (const m of rankedNames) noteNameCandidate(card, m, 'word');
					log(`Card ${cardIdx + 1}: word best match "${best.name}" score=${best.score.toFixed(3)}`);
					if (nameIdentifies(best, cleanName)) {
						card.results = wData.results.filter((r: Record<string, unknown>) => r.name === best.name);
						card.matchType = 'similarity';
						log(`Card ${cardIdx + 1}: word fallback accepted "${best.name}" -> ${card.results.length} reprints`);
					}
				}
			}
			// Best rotated name OCR text per card, adopted when Phase 3 switches a
			// card to its rotated warp because the collector line reads better there.
			const rotatedNameText = new Map<number, string>();

			// Batch-search OCR name texts and accept the best match per card when
			// it identifies the card on its own (nameIdentifies: score, name length,
			// a real word in the text). Shared by the raw-line pass and the
			// upside-down retry; returns the indices (relative to firstIdx) that
			// resolved. The best few names of every pass are recorded as evidence
			// for the fusion, so a close runner-up is never lost.
			async function acceptNameMatches(items: Array<{ i: number; cleanName: string }>, tag: string): Promise<number[]> {
				const accepted: number[] = [];
				if (items.length === 0 || superseded()) return accepted;
				let batch: Array<{ query: string; results: Record<string, unknown>[]; matchType: string }> = [];
				try {
					const res = await fetch('/scan', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ queries: items.map((q) => q.cleanName) })
					});
					const data = await res.json();
					batch = Array.isArray(data?.batch) ? data.batch : [];
				} catch (err) {
					log(`${tag}: batch search error: ${err}`);
					return accepted;
				}
				items.forEach(({ i, cleanName }, qi) => {
					const card = detectedCards[firstIdx + i];
					const searchData = batch[qi];
					if (!searchData || searchData.results.length === 0) return;
					const rankedNames = rankNameMatches(searchData.results, cleanName);
					const best = rankedNames[0] ?? { name: '', score: 0 };
					log(`Card ${firstIdx + i + 1} ${tag}: best match "${best.name}" score=${best.score.toFixed(3)}`);
					for (const m of rankedNames) noteNameCandidate(card, m, tag);
					if (!nameIdentifies(best, cleanName)) return;
					card.results = searchData.results.filter((x: Record<string, unknown>) => x.name === best.name);
					card.matchType = searchData.matchType;
					card.nameText = cleanName;
					accepted.push(i);
					log(`Card ${firstIdx + i + 1}: accepted (${tag}) -> "${best.name}" (${card.results.length} reprints)`);
				});
				return accepted;
			}

			// OCR name crops with the given page-segmentation mode; texts are
			// index-aligned with `urls`.
			async function ocrNames(urls: string[], psm: '7' | '13'): Promise<string[]> {
				await setPoolParameters(pool, { tessedit_char_whitelist: NAME_WHITELIST, tessedit_pageseg_mode: psm });
				const texts = await recognizeBatch(pool, urls);
				return texts.map((t) => t.replace(/[\r\n]+/g, ' ').trim());
			}
			const cleanNameOf = (text: string) => text.replace(/^[^A-Za-z]+/, '').trim();
			const unresolved = (): number[] => {
				const out: number[] = [];
				for (let i = 0; i < newCount; i++) if (detectedCards[firstIdx + i].results.length === 0) out.push(i);
				return out;
			};

			// Name passes beyond the first (gray, PSM 7): a binarised copy of the
			// same band (PSM 7) and a binarised 2x copy in raw-line mode (PSM 13).
			// Each reads a different subset of name bars — on 75 real-photo cards
			// the union is 68 against 60 for the two gray passes. Only the cards
			// still unresolved pay for them; the same list serves the rotated retry.
			type NameCrops = { nameUrl: string; nameUrl2?: string; nameUrl3?: string; nameUrl4?: string };
			type NamePass = { engine: 'tesseract' | 'paddle'; psm: '7' | '13'; pick: (c: NameCrops) => string; tag: string };
			const extraNamePasses: NamePass[] = [
				{ engine: 'tesseract', psm: '7', pick: (c) => c.nameUrl3 ?? c.nameUrl, tag: 'binarized' },
				{ engine: 'tesseract', psm: '13', pick: (c) => c.nameUrl2 ?? c.nameUrl, tag: 'raw-line' },
				// Gray raw line: binarisation erases light text on busy art
				// (showcase frames), and this pass alone rescued such a card.
				{ engine: 'tesseract', psm: '13', pick: (c) => c.nameUrl4 ?? c.nameUrl, tag: 'raw-line gray' },
				// Second engine last, so only stubborn cards pay its lazy ~25 MB
				// download: PaddleOCR reads a different subset of name bars than
				// Tesseract (64 vs 65 of 75 alone, 72 together).
				{ engine: 'paddle', psm: '7', pick: (c) => c.nameUrl, tag: 'paddle' }
			];
			const runNamePass = async (pass: NamePass, urls: string[]): Promise<string[]> => {
				if (pass.engine === 'paddle') {
					const texts = await paddleRecognizeLines(urls);
					if (texts.every((t) => t === '')) log('PaddleOCR pass: no text (engine unavailable or nothing read)');
					return texts.map((t) => t.replace(/[\r\n]+/g, ' ').trim());
				}
				return ocrNames(urls, pass.psm);
			};

			// Phase 2a: extra name passes for the cards the first pass didn't resolve.
			for (const pass of extraNamePasses) {
				const idx = unresolved();
				if (idx.length === 0 || superseded()) break;
				log(`Phase 2a: ${pass.tag} name OCR (${pass.engine === 'paddle' ? 'PaddleOCR PP-OCRv4' : `Tesseract PSM ${pass.psm}`}) for ${idx.length} unresolved card(s)`);
				scanProgress = `Re-reading ${idx.length} name${idx.length === 1 ? '' : 's'}...`;
				const texts = await runNamePass(pass, idx.map((i) => pass.pick(detectedCards[firstIdx + i])));
				const items: Array<{ i: number; cleanName: string }> = [];
				idx.forEach((i, k) => {
					const card = detectedCards[firstIdx + i];
					log(`Card ${firstIdx + i + 1} ${pass.tag} name OCR: "${texts[k]}"`);
					const cleanName = cleanNameOf(texts[k]);
					if (cleanName.length >= 2) items.push({ i, cleanName });
					// Keep the more informative text for the plausibility checks later on.
					if (realWordCount(cleanName) > realWordCount(card.nameText)) card.nameText = cleanName;
				});
				await acceptNameMatches(items, pass.tag);
			}

			// Phase 2b: upside-down retry. orderCornersForCard() cannot tell a
			// card's top from its bottom when the card lies sideways (or upside
			// down): both short edges are geometrically identical, so about half
			// of such cards leave the warp rotated 180° and their name OCR reads
			// garbage. For every card the name search didn't resolve, re-crop the
			// name band from the 180°-rotated warp, OCR it again (single-line pass,
			// then raw-line pass) and search again; when that yields a real name,
			// the rotated crops replace the originals so the bottom-line phase
			// reads the right strip as well.
			type RotCrops = { canvas: HTMLCanvasElement; nameUrl: string; nameUrl2: string; nameUrl3: string; nameUrl4: string; bottomUrl: string; bottomUrl2: string; bottomCanvas: HTMLCanvasElement };
			{
				const retryIdx = unresolved();
				if (retryIdx.length > 0 && !superseded()) {
					log(`Phase 2b: upside-down retry for ${retryIdx.length} unresolved card(s) [${retryIdx.map((i) => `Card ${firstIdx + i + 1}`).join(', ')}]`);
					scanProgress = `Retrying ${retryIdx.length} card${retryIdx.length === 1 ? '' : 's'} rotated...`;
					const rotated = new Map<number, RotCrops>();
					for (const i of retryIdx) {
						const original = cardCanvases[i];
						const rot = document.createElement('canvas');
						rot.width = original.width;
						rot.height = original.height;
						const rctx = rot.getContext('2d');
						if (!rctx) continue;
						rctx.translate(rot.width, rot.height);
						rctx.rotate(Math.PI);
						rctx.drawImage(original, 0, 0);
						const rotMat = cv.imread(rot);
						try {
							const crops = extractOcrCrops(rotMat, !!cardContours[i].synthetic, `Card ${firstIdx + i + 1} (rotated)`);
							rotated.set(i, { canvas: rot, ...crops });
						} finally {
							rotMat.delete();
						}
					}
					// Whether or not the rotated name resolves, keep the rotated crops:
					// Phase 3 reads the collector line in both orientations for cards
					// that are still unresolved, so an unreadable name doesn't waste a
					// perfectly legible "C 0156 TMT EN" on the other side.
					for (const [i, r] of rotated) {
						const card = detectedCards[firstIdx + i];
						card.altNameUrl = r.nameUrl;
						card.altNameUrl2 = r.nameUrl2;
						card.altNameUrl3 = r.nameUrl3;
						card.altNameUrl4 = r.nameUrl4;
						card.altBottomUrl = r.bottomUrl;
						card.altBottomUrl2 = r.bottomUrl2;
						card.altCroppedUrl = cardThumbnailUrl(r.canvas);
					}
					// Switch a card to its rotated warp once the rotated name matched.
					const adopt = (i: number) => {
						const r = rotated.get(i);
						if (!r) return;
						const card = detectedCards[firstIdx + i];
						card.altNameUrl = undefined;
						card.altNameUrl2 = undefined;
						card.altNameUrl3 = undefined;
						card.altNameUrl4 = undefined;
						card.altBottomUrl = undefined;
						card.altBottomUrl2 = undefined;
						card.altCroppedUrl = undefined;
						card.nameUrl = r.nameUrl;
						card.nameUrl2 = r.nameUrl2;
						card.nameUrl3 = r.nameUrl3;
						card.nameUrl4 = r.nameUrl4;
						card.bottomUrl = r.bottomUrl;
						card.bottomUrl2 = r.bottomUrl2;
						card.croppedUrl = cardThumbnailUrl(r.canvas);
						bottomCanvases[i] = r.bottomCanvas;
						cardCanvases[i] = r.canvas;
						log(`Card ${firstIdx + i + 1}: accepted after 180° rotation`);
					};
					// Same passes as upright: gray single line first, then the extra passes.
					const passes: Array<{ engine: 'tesseract' | 'paddle'; psm: '7' | '13'; pick: (r: RotCrops) => string; tag: string }> = [
						{ engine: 'tesseract', psm: '7', pick: (r) => r.nameUrl, tag: 'rotated' },
						...extraNamePasses.map((p) => ({ engine: p.engine, psm: p.psm, pick: (r: RotCrops) => p.pick(r), tag: `rotated ${p.tag}` }))
					];
					for (const pass of passes) {
						const idx = [...rotated.keys()].filter((i) => detectedCards[firstIdx + i].results.length === 0);
						if (idx.length === 0 || superseded()) break;
						const texts = await runNamePass({ ...pass, pick: (c: NameCrops) => c.nameUrl }, idx.map((i) => pass.pick(rotated.get(i)!)));
						const items: Array<{ i: number; cleanName: string }> = [];
						idx.forEach((i, k) => {
							log(`Card ${firstIdx + i + 1} ${pass.tag} name OCR: "${texts[k]}"`);
							const cleanName = cleanNameOf(texts[k]);
							if (cleanName.length >= 2) items.push({ i, cleanName });
							if (!rotatedNameText.has(i) || realWordCount(cleanName) > realWordCount(rotatedNameText.get(i) ?? '')) rotatedNameText.set(i, cleanName);
						});
						for (const i of await acceptNameMatches(items, pass.tag)) adopt(i);
					}
				}
			}
			detectedCards = [...detectedCards];

			// Phase 3: OCR the collector strips (every variant), then fuse all
			// evidence per card — name candidates from every pass plus one reading
			// per strip variant — into identity / printing / finish decisions
			// (src/lib/scanner/resolve.ts). The OCR phases only collect evidence.
			await setPoolParameters(pool, {
				tessedit_char_whitelist: BOTTOM_WHITELIST,
				tessedit_pageseg_mode: '6'
			});
			const langs = 'EN|DE|FR|IT|ES|JA|PT|RU|ZH|KO';
			log(`Phase 3: Bottom OCR (Tesseract PSM 6, ${pool.length} workers)`);
			const newCards = detectedCards.slice(firstIdx);
			const bottomUrls = newCards.map((c) => c.bottomUrl);
			// Every card whose printing is not settled by a unique name hit gets
			// its smaller strip and, when the upside-down retry produced one, both
			// rotated strips OCR'd as well; all of them become readings.
			type StripVariant = { i: number; url: string; rotated: boolean; label: string };
			const extra: StripVariant[] = [];
			for (let i = 0; i < newCount; i++) {
				const c = newCards[i];
				if (c.results.length === 1) continue;
				if (c.bottomUrl2) extra.push({ i, url: c.bottomUrl2, rotated: false, label: 'small' });
				if (c.altBottomUrl) extra.push({ i, url: c.altBottomUrl, rotated: true, label: 'rotated' });
				if (c.altBottomUrl2) extra.push({ i, url: c.altBottomUrl2, rotated: true, label: 'rotated small' });
			}
			const bottomTexts = await recognizeBatch(pool, [...bottomUrls, ...extra.map((e) => e.url)], (done, total) => {
				scanProgress = `OCR bottom ${done}/${total}...`;
			});
			const cleanOcr = (t: string) => t.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
			const readingOf = (text: string, variant: string, trustFoil = false): FooterReading => ({ ...parseCollectorInfo(text, langs), text, variant, trustFoil });
			for (let i = 0; i < newCount; i++) {
				const card = detectedCards[firstIdx + i];
				card.ocrText = cleanOcr(bottomTexts[i]);
				log(`Card ${firstIdx + i + 1} bottom OCR: "${card.ocrText}"`);
				card.readings = [readingOf(card.ocrText, 'primary')];
			}
			// Which orientation to *show*: the strip that parses best as a
			// collector line. A card that came out of the warp upside down and
			// whose rotated name OCR was too poor to match is switched to its
			// rotated warp here; every variant stays in `readings` regardless.
			const stripScore = (p: { setCode: string; collectorNumber: string; numberSource: string }) =>
				(p.setCode ? 2 : 0) + (p.collectorNumber ? (p.numberSource === 'weak' ? 1 : 2) : 0);
			const variantsByCard = new Map<number, Array<StripVariant & { text: string }>>();
			extra.forEach((e, k) => {
				const text = cleanOcr(bottomTexts[newCount + k]);
				log(`Card ${firstIdx + e.i + 1} bottom OCR (${e.label}): "${text}"`);
				detectedCards[firstIdx + e.i].readings.push(readingOf(text, e.label));
				let list = variantsByCard.get(e.i);
				if (!list) {
					list = [];
					variantsByCard.set(e.i, list);
				}
				list.push({ ...e, text });
			});
			for (const [i, variants] of variantsByCard) {
				const card = detectedCards[firstIdx + i];
				let bestScore = stripScore(parseCollectorInfo(card.ocrText, langs));
				let best: (StripVariant & { text: string }) | null = null;
				for (const v of variants) {
					const score = stripScore(parseCollectorInfo(v.text, langs));
					if (score > bestScore) {
						bestScore = score;
						best = v;
					}
				}
				if (best) {
					log(`Card ${firstIdx + i + 1}: ${best.label} strip reads better, showing it`);
					card.ocrText = best.text;
					if (best.rotated && card.altBottomUrl && card.altNameUrl && card.altCroppedUrl) {
						log(`Card ${firstIdx + i + 1}: switching to the rotated warp`);
						card.bottomUrl = card.altBottomUrl;
						card.bottomUrl2 = card.altBottomUrl2;
						card.nameUrl = card.altNameUrl;
						card.nameUrl2 = card.altNameUrl2;
						card.nameUrl3 = card.altNameUrl3;
						card.nameUrl4 = card.altNameUrl4;
						card.croppedUrl = card.altCroppedUrl;
						const rt = rotatedNameText.get(i);
						if (rt !== undefined && realWordCount(rt) >= realWordCount(card.nameText)) card.nameText = rt;
					}
				}
				card.altNameUrl = undefined;
				card.altNameUrl2 = undefined;
				card.altNameUrl3 = undefined;
				card.altNameUrl4 = undefined;
				card.altBottomUrl = undefined;
				card.altBottomUrl2 = undefined;
				card.altCroppedUrl = undefined;
			}
			for (let i = 0; i < newCount; i++) {
				const card = detectedCards[firstIdx + i];
				const shown = parseCollectorInfo(card.ocrText, langs);
				card.setCode = shown.setCode;
				card.collectorNumber = shown.collectorNumber;
			}
			if (superseded()) return;

			// Evidence fusion. The resolver is pure, so everything it may ask for is
			// prefetched in two batched round trips: every printing of every name
			// candidate worth joining, and every set+number a reading produced (plus
			// the majority set's number in the second pass).
			const printingsCache = new Map<string, PrintingRow[]>();
			const lookupCache = new Map<string, PrintingRow[]>();
			const nearCache = new Map<string, PrintingRow[]>();
			const knownSets = new Map<string, boolean>();
			const lookupKey = (setCode: string, n: string) => `${setCode.toLowerCase()}|${n}`;
			const nearKey = (setCode: string, n: string, rarity: string) => `${setCode.toLowerCase()}|${n}|${rarity}`;
			const structural = (r: FooterReading) => isStructural(r.numberSource);
			async function prefetch(cards: typeof detectedCards, majoritySet: string | null) {
				const names = new Set<string>();
				const lookups: Array<{ setCode: string; collectorNumber: string }> = [];
				const near: Array<{ setCode: string; collectorNumber: string; rarity: string }> = [];
				const want = (setCode: string, n: string) => {
					if (!setCode || lookupCache.has(lookupKey(setCode, n))) return;
					lookupCache.set(lookupKey(setCode, n), []);
					lookups.push({ setCode, collectorNumber: n });
				};
				const wantNear = (setCode: string, n: string, rarity: string) => {
					if (!setCode || !n || nearCache.has(nearKey(setCode, n, rarity))) return;
					nearCache.set(nearKey(setCode, n, rarity), []);
					near.push({ setCode, collectorNumber: n, rarity });
				};
				for (const c of cards) {
					for (const cand of c.nameCandidates) if (cand.score >= NAME_LIKELY && !printingsCache.has(cand.name)) names.add(cand.name);
					for (const r of c.readings) {
						if (r.setCode) want(r.setCode, r.collectorNumber);
						if (majoritySet && r.collectorNumber) want(majoritySet, r.collectorNumber);
						// Suggestions for unreadable names: numbers one OCR error away.
						if (structural(r)) {
							if (r.setCode) wantNear(r.setCode, r.collectorNumber, r.rarity);
							if (majoritySet) wantNear(majoritySet, r.collectorNumber, r.rarity);
						}
					}
				}
				try {
					// The server answers at most 50 names per request; a busy spread with
					// three candidates per pass exceeds that, and every name beyond the
					// cut used to come back without printings ("confirmed", nothing to pick).
					const nameList = [...names];
					for (let start = 0; start < nameList.length; start += 50) {
						const res = await fetch('/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ printings: nameList.slice(start, start + 50) }) });
						const data = await res.json();
						for (const entry of Array.isArray(data?.batch) ? data.batch : []) printingsCache.set(entry.name, entry.results ?? []);
					}
					for (let start = 0; start < lookups.length; start += 100) {
						const chunk = lookups.slice(start, start + 100);
						const res = await fetch('/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lookups: chunk }) });
						const data = await res.json();
						for (const entry of Array.isArray(data?.batch) ? data.batch : []) {
							lookupCache.set(lookupKey(entry.setCode, entry.collectorNumber), entry.results ?? []);
							knownSets.set(String(entry.setCode).toLowerCase(), !!entry.setKnown);
						}
					}
					for (let start = 0; start < near.length; start += 100) {
						const chunk = near.slice(start, start + 100);
						const res = await fetch('/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ near: chunk }) });
						const data = await res.json();
						for (const entry of Array.isArray(data?.batch) ? data.batch : []) nearCache.set(nearKey(entry.setCode, entry.collectorNumber, entry.rarity ?? ''), entry.results ?? []);
					}
					log(`Phase 3 prefetch: ${names.size} name(s), ${lookups.length} set+number lookup(s), ${near.length} near-number lookup(s)`);
				} catch (err) {
					log(`Phase 3 prefetch error: ${err}`);
				}
			}
			function resolveOne(card: typeof detectedCards[number], cardIdx: number, majoritySet: string | null) {
				const d = resolveCard({
					nameCandidates: card.nameCandidates,
					nameText: card.nameText,
					footer: card.readings,
					majoritySet,
					printingsByName: (n) => printingsCache.get(n) ?? [],
					lookup: (setCode, n) => lookupCache.get(lookupKey(setCode, n)) ?? [],
					nearLookup: (setCode, n, rarity) => nearCache.get(nearKey(setCode, n, rarity)) ?? [],
					isKnownSet: (setCode) => (majoritySet !== null && setCode.toLowerCase() === majoritySet) || (knownSets.get(setCode.toLowerCase()) ?? false)
				});
				for (const r of d.reasons) log(`Card ${cardIdx}: ${r}`);
				card.reasons = d.reasons;
				card.finish = d.finish;
				card.foil = d.finish === 'foil';
				card.language = d.language;
				card.suggestions = [];
				const row = d.printing.row;
				const cands = d.printing.candidates;
				switch (d.identity.state) {
					case 'confirmed':
						card.status = 'found';
						card.results = row ? [row] : cands;
						card.printingState = d.printing.state === 'confirmed' ? 'confirmed' : 'unknown';
						card.matchType = 'resolved';
						break;
					case 'likely':
						card.status = 'likely';
						card.results = row ? [row, ...cands.filter((c) => c !== row)] : cands;
						card.printingState = 'likely';
						break;
					case 'conflict':
						card.status = 'conflict';
						card.results = cands;
						card.printingState = 'conflict';
						break;
					default:
						card.status = 'not_found';
						card.results = [];
						card.printingState = 'unknown';
						card.suggestions = cands.slice(0, 3);
				}
				card.selectedResultIdx = 0;
				log(`Card ${cardIdx}: identity ${d.identity.state}${d.identity.name ? ` "${d.identity.name}"` : ''}, printing ${d.printing.state}${row ? ` ${row.set_code}#${row.collector_number}` : ''}, finish ${d.finish}`);
			}
			const unsettled = () => detectedCards.slice(firstIdx).filter((c) => !(c.status === 'found' && c.printingState === 'confirmed'));
			scanProgress = 'Matching...';
			await prefetch(detectedCards.slice(firstIdx), null);
			if (superseded()) return;
			for (let i = 0; i < newCount; i++) resolveOne(detectedCards[firstIdx + i], firstIdx + i + 1, null);
			// Second pass: the set most confirmed cards belong to helps the rest.
			const majoritySet = majoritySetOf(detectedCards.slice(firstIdx));
			if (majoritySet && unsettled().length > 0) {
				log(`Phase 3c: majority set ${majoritySet.toUpperCase()} for ${unsettled().length} unsettled card(s)`);
				await prefetch(unsettled(), majoritySet);
				if (superseded()) return;
				for (let i = 0; i < newCount; i++) {
					const c = detectedCards[firstIdx + i];
					if (!(c.status === 'found' && c.printingState === 'confirmed')) resolveOne(c, firstIdx + i + 1, majoritySet);
				}
			}

			// Pixel-based foil detection — only for single-card mode where the
			// bottom strip is large enough to reliably sample the separator.
			// Multi-card scans skip this (per-card resolution too low).
			if (scanMode === 'single' && newCount === 1 && bottomCanvases[0]) {
				const card = detectedCards[firstIdx];
				if (card.setCode) {
					const detailed = await recognizeDetailed(pool, card.bottomUrl);
					const langList = langs.split('|');
					const foilResult = detectFoilFromSeparator(
						bottomCanvases[0],
						detailed.words,
						card.setCode,
						langList,
						(m) => log(`Card 1: ${m}`)
					);
					if (foilResult) {
						card.finish = foilResult.foil ? 'foil' : 'nonfoil';
						card.foil = foilResult.foil;
						log(`Card 1: pixel foil detection -> ${card.finish} (bright=${(foilResult.brightRatio * 100).toFixed(1)}%)`);
					}
				}
			}
			detectedCards = [...detectedCards];

			// Phase 3b: Optional Google Vision retry. If the user has stored a personal
			// API key in /settings AND the toggle on this page is enabled, send the
			// name band and the collector strip of every card that is not settled
			// (identity or printing) to Vision: the name text becomes one more name
			// candidate, the strip one more reading — the only reading whose foil
			// hint (★ vs •) is trusted — and the fusion runs again.
			if (superseded()) return;
			const userHasVisionKey = !!data.user?.hasVisionApiKey;
			if (userHasVisionKey && visionRetryEnabled) {
				const failed: Array<{ card: typeof detectedCards[number]; index: number }> = [];
				for (let i = firstIdx; i < detectedCards.length; i++) {
					const c = detectedCards[i];
					if (!(c.status === 'found' && c.printingState === 'confirmed')) failed.push({ card: c, index: i });
				}
				if (failed.length > 0) {
					log(`Phase 3b: Vision retry for ${failed.length} card(s) [${failed.map(f => `Card ${f.index + 1}`).join(', ')}]`);
					const retried: typeof failed = [];
					const visionNames: Array<{ i: number; cleanName: string }> = [];
					// /api/ocr accepts up to 16 images per request: two per card
					// (name band, collector strip), so eight cards per request.
					for (let batchStart = 0; batchStart < failed.length; batchStart += 8) {
						const batch = failed.slice(batchStart, batchStart + 8);
						scanProgress = `Retrying ${batch.length} card${batch.length === 1 ? '' : 's'} with Google Vision...`;
						try {
							const res = await fetch('/api/ocr', {
								method: 'POST',
								headers: { 'Content-Type': 'application/json' },
								body: JSON.stringify({ images: batch.flatMap(({ card }) => [card.nameUrl, card.bottomUrl]) })
							});
							if (res.ok) {
								const visionData = await res.json();
								for (let j = 0; j < batch.length; j++) {
									const { card, index: cardIdx } = batch[j];
									const nameText = cleanOcr((visionData.results?.[2 * j] ?? '').toString());
									const stripText = cleanOcr((visionData.results?.[2 * j + 1] ?? '').toString());
									if (!nameText && !stripText) continue;
									log(`Card ${cardIdx + 1}: Vision name="${nameText}" strip="${stripText}" (Tesseract strip was="${card.ocrText}")`);
									if (stripText) card.readings.push(readingOf(stripText, 'vision', true));
									const cleanName = cleanNameOf(nameText);
									if (cleanName.length >= 2) {
										visionNames.push({ i: cardIdx - firstIdx, cleanName });
										if (realWordCount(cleanName) > realWordCount(card.nameText)) card.nameText = cleanName;
									}
									retried.push(batch[j]);
									visionRetriedCount++;
								}
							}
						} catch { /* keep Tesseract result for this batch */ }
					}
					if (visionNames.length > 0 && !superseded()) await acceptNameMatches(visionNames, 'vision');
					if (retried.length > 0 && !superseded()) {
						await prefetch(retried.map((f) => f.card), majoritySet);
						for (const { card, index } of retried) {
							resolveOne(card, index + 1, majoritySet);
							log(`Card ${index + 1}: after Vision retry -> ${card.status}, printing ${card.printingState}`);
						}
						detectedCards = [...detectedCards];
					}
				} else {
					log('Phase 3b: Vision retry skipped (no unsettled cards)');
				}
			} else {
				log(`Phase 3b: Vision retry ${!userHasVisionKey ? 'no API key' : 'disabled by toggle'}`);
			}

			const newSlice = detectedCards.slice(firstIdx);
			const identifiedCount = newSlice.filter((c) => c.status === 'found').length;
			const likelyCount = newSlice.filter((c) => c.status === 'likely' || c.status === 'conflict').length;
			log(`Scan complete: ${identifiedCount}/${newSlice.length} identified${likelyCount ? `, ${likelyCount} to confirm` : ''}`);
			scanProgress = `Done! ${identifiedCount} of ${newSlice.length} identified${likelyCount ? `, ${likelyCount} to confirm` : ''}.`;
		} catch (err) {
			scanProgress = `Error: ${(err as Error).message}`;
		} finally {
			// Don't clear the busy flag if a newer scan superseded us — that scan
			// owns `scanning` now.
			if (!superseded()) scanning = false;
		}
	}

	// loadImage, fixOcrDigits, stripLeadingZeros, parseCollectorInfo,
	// similarity, bestNameMatch, orderCorners all come from src/lib/scanner/.

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
		// Prefill with what the OCR did read: the best name candidate, else the raw text.
		const bestCandidate = [...card.nameCandidates].sort((a, b) => b.score - a.score)[0];
		manualQuery = bestCandidate?.name ?? card.nameText.replace(/^[^A-Za-z]+/, '').trim();
		manualMode = manualQuery.length >= 3 ? 'name' : 'set';
		manualResults = [];
	}

	/** One tap on a likely / conflict / suggested card: take this printing as confirmed. */
	function acceptCandidate(cardIndex: number, row: Record<string, unknown>) {
		const card = detectedCards[cardIndex];
		card.status = 'found';
		card.results = [row];
		card.selectedResultIdx = 0;
		card.printingState = 'confirmed';
		card.suggestions = [];
		card.matchType = 'accepted';
		log(`Card ${cardIndex + 1}: accepted by user -> ${row.set_code}#${row.collector_number} "${row.name}"`);
		detectedCards = [...detectedCards];
	}

	/** "Not this card": drop the offer and open the manual search. */
	function rejectCandidate(cardIndex: number) {
		const card = detectedCards[cardIndex];
		card.status = 'not_found';
		card.results = [];
		card.suggestions = [];
		card.printingState = 'unknown';
		detectedCards = [...detectedCards];
		openManualSearch(cardIndex);
	}

	/** Finish toggle: unknown -> foil -> nonfoil -> unknown. */
	function cycleFinish(cardIndex: number) {
		const card = detectedCards[cardIndex];
		card.finish = card.finish === 'unknown' ? 'foil' : card.finish === 'foil' ? 'nonfoil' : 'unknown';
		card.foil = card.finish === 'foil';
		detectedCards = [...detectedCards];
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
			if (isImportable(card)) {
				const selectedResult = card.results[card.selectedResultIdx];
				if (!addedCards.some(a => a.id === selectedResult.id)) {
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
			if (isImportable(card)) {
				const result = card.results[card.selectedResultIdx];
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
		scanToken++; // invalidate any in-flight scan
		if (imagePreview) URL.revokeObjectURL(imagePreview);
		imagePreview = '';
		detectedCards = [];
		debugCanvasUrl = '';
		debugLog = [];
		scanProgress = '';
		manualResults = [];
		manualCardIndex = null;
		selectedCards = new Set();
	}

	let scanSort = $state<'default' | 'price'>('default');
	let sortedCards = $derived(() => {
		if (scanSort === 'price') {
			return [...detectedCards].map((c, i) => ({ card: c, origIdx: i }))
				.sort((a, b) => {
					const priceA = a.card.results.length > 0 ? getCardPrice(a.card.results[a.card.selectedResultIdx]) : 0;
					const priceB = b.card.results.length > 0 ? getCardPrice(b.card.results[b.card.selectedResultIdx]) : 0;
					return priceB - priceA;
				});
		}
		return detectedCards.map((c, i) => ({ card: c, origIdx: i }));
	});

	function getCardPrice(result: Record<string, unknown>): number {
		return (result.price_eur as number | null) ?? (result.price_usd as number | null) ?? 0;
	}

	let copied = $state(false);

	function getMoxfieldText(): string {
		const lines: string[] = [];
		for (const card of detectedCards) {
			if (isImportable(card)) {
				const r = card.results[card.selectedResultIdx];
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

<svelte:head>
	<title>MTG Card Scanner - Scan Entire Boosters at Once | MTG Collector</title>
	<meta name="description" content="Scan multiple Magic: The Gathering cards in one photo. Place an entire booster pack or spread of cards on the table, take a picture, and let our scanner detect, identify, and price-check every card automatically — including foil detection." />
	<link rel="canonical" href="https://mtg-collector.com/scan" />
	<meta property="og:title" content="MTG Card Scanner - Scan & Identify Cards | MTG Collector" />
	<meta property="og:description" content="Scan Magic: The Gathering cards with your camera. Automatic card detection, OCR recognition, foil detection, and price lookup." />
	<meta property="og:url" content="https://mtg-collector.com/scan" />
</svelte:head>

<div class="space-y-5">
	<div class="page-heading">
		<div>
			<p class="eyebrow">Scanner</p>
			<h1 class="mt-1 text-[22px] font-semibold text-[var(--color-text-strong)]">Card Scanner</h1>
		</div>
		{#if !loggedIn}
			<p class="text-sm text-[var(--color-text-muted)]">
				<a href="/login" class="text-[var(--color-primary)] hover:underline">Sign in</a> to add scanned cards to your collection
			</p>
		{/if}
	</div>

	<!-- Upload / Live -->
	{#if scanMode === 'live'}
		<div class="flex items-center gap-2">
			<span class="text-xs text-[var(--color-text-muted)]">Mode:</span>
			<div class="inline-flex rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
				<button type="button" onclick={() => (scanMode = 'single')}
					class="px-3 py-1 text-xs rounded-md transition-colors text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Single card</button>
				<button type="button" onclick={() => (scanMode = 'multiple')}
					class="px-3 py-1 text-xs rounded-md transition-colors text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Multiple cards</button>
				<button type="button" onclick={() => (scanMode = 'live')}
					class="px-3 py-1 text-xs rounded-md transition-colors bg-[var(--color-primary)] text-white">Live camera</button>
			</div>
			{#if detectedCards.length > 0}
				<button type="button" onclick={reset}
					class="ml-auto text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] underline">
					Clear captured ({detectedCards.length})
				</button>
			{/if}
		</div>
		<LiveScanner onCapture={handleLiveCapture} busy={scanning} log={(m) => log(`[live] ${m}`)} />
	{:else if !imagePreview}
		<label class="panel flex h-48 cursor-pointer flex-col items-center justify-center border-dashed transition-colors hover:border-[var(--color-primary)]">
			<svg class="w-12 h-12 text-[var(--color-text-muted)] mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
				<path stroke-linecap="round" stroke-linejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
			</svg>
			<p class="text-[var(--color-text-muted)] font-medium">Upload photo of card(s)</p>
			<p class="text-xs text-[var(--color-text-muted)] mt-1">Detects multiple cards in one image</p>
			<input type="file" accept="image/*" capture="environment" onchange={onFileSelect} class="hidden" />
		</label>
		<div class="flex items-center gap-2 mt-3">
			<span class="text-xs text-[var(--color-text-muted)]">Mode:</span>
			<div class="inline-flex rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
				<button
					type="button"
					onclick={() => (scanMode = 'single')}
					class="px-3 py-1 text-xs rounded-md transition-colors {scanMode === 'single'
						? 'bg-[var(--color-primary)] text-white'
						: 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}"
				>
					Single card
				</button>
				<button
					type="button"
					onclick={() => (scanMode = 'multiple')}
					class="px-3 py-1 text-xs rounded-md transition-colors {scanMode === 'multiple'
						? 'bg-[var(--color-primary)] text-white'
						: 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}"
				>
					Multiple cards
				</button>
				<button
					type="button"
					onclick={() => (scanMode = 'live')}
					class="px-3 py-1 text-xs rounded-md transition-colors text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
				>
					Live camera
				</button>
			</div>
		</div>

		<p class="text-xs text-[var(--color-text-muted)] mt-3 p-3 rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
			<svg class="inline w-4 h-4 mr-1 -mt-0.5 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
			</svg>
			<strong class="text-[var(--color-text)]">Tip:</strong>
			For best results, place the card(s) on a plain white background — a sheet of white paper works perfectly. When scanning multiple cards, leave a small gap between each card so the detector can separate them.
		</p>

		{#if data.user?.hasVisionApiKey}
			<label class="flex items-center gap-2 mt-3 cursor-pointer select-none">
				<input
					type="checkbox"
					bind:checked={visionRetryEnabled}
					class="w-4 h-4 rounded border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-primary)] focus:ring-[var(--color-primary)]"
				/>
				<span class="text-xs text-[var(--color-text-muted)]">
					Retry unrecognized cards with Google Vision API (uses your personal key)
				</span>
			</label>
		{/if}

		<p class="text-xs text-[var(--color-text-muted)] mt-2">
			<svg class="inline w-3 h-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
			</svg>
			Card recognition runs locally in your browser using Tesseract.
			{#if data.user?.hasVisionApiKey}
				When the toggle above is on, cards that local OCR can't identify are retried via Google's Vision API using your personal key.
			{:else}
				Optionally, add your own
				<a href="/settings" class="underline hover:text-[var(--color-primary)]">Google Vision API key</a>
				in Settings to retry unrecognized cards via Google's Vision API.
			{/if}
			<a href="/datenschutz#m-ocr" class="underline hover:text-[var(--color-primary)]">Learn more</a>
		</p>
	{/if}

	<!-- Scanning Status -->
	{#if scanning}
		<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-4 flex items-center gap-3">
			<div class="w-5 h-5 border-2 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin"></div>
			<span class="text-sm">{scanProgress}</span>
		</div>
	{:else if scanProgress && (imagePreview || scanMode === 'live')}
		<!-- Live captures have no imagePreview; still show the final "Done! x of y identified." line. -->
		<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-3 text-sm text-[var(--color-text-muted)]">
			{scanProgress}
		</div>
	{/if}

	<!-- Post-scan note about Google Vision retries -->
	{#if !scanning && visionRetriedCount > 0}
		<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-3 text-xs text-[var(--color-text-muted)]">
			<svg class="inline w-3 h-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
			</svg>
			{visionRetriedCount} card{visionRetriedCount === 1 ? '' : 's'} retried with Google Vision using your personal API key.
		</div>
	{/if}

	<!-- Detected Cards -->
	{#if detectedCards.length > 0}
		{@const identifiedCount = detectedCards.filter(c => isImportable(c) && !addedCards.some(a => a.id === c.results[c.selectedResultIdx].id)).length}
		{@const hasIdentified = detectedCards.some(c => isImportable(c))}
		{@const toConfirm = detectedCards.filter(c => c.status === 'likely' || c.status === 'conflict' || (c.status === 'found' && !isImportable(c))).length}
		{#if !scanning && (identifiedCount > 0 || hasIdentified)}
			<div class="flex gap-3 items-center flex-wrap">
				{#if toConfirm > 0}
					<span class="text-xs px-2 py-1 rounded bg-yellow-500/15 text-yellow-300 border border-yellow-500/30">{toConfirm} card{toConfirm === 1 ? '' : 's'} need{toConfirm === 1 ? 's' : ''} a tap to confirm</span>
				{/if}
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
					<div class="flex items-center gap-1 ml-auto">
						<span class="text-xs text-[var(--color-text-muted)] mr-1">Sort:</span>
						<button onclick={() => scanSort = 'default'}
							class="px-2 py-1 rounded text-xs border transition-colors {scanSort === 'default'
								? 'bg-[var(--color-primary-button)] border-[var(--color-primary-button)] text-white'
								: 'border-[var(--color-border)] hover:border-[var(--color-text-muted)]'}">
							Scan order
						</button>
						<button onclick={() => scanSort = 'price'}
							class="px-2 py-1 rounded text-xs border transition-colors {scanSort === 'price'
								? 'bg-[var(--color-primary-button)] border-[var(--color-primary-button)] text-white'
								: 'border-[var(--color-border)] hover:border-[var(--color-text-muted)]'}">
							Price
						</button>
					</div>
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
			{#each sortedCards() as { card, origIdx }, idx}
				{@const cardState = card.status === 'found' ? 'confirmed' : card.status === 'likely' ? 'likely' : card.status === 'conflict' ? 'conflict' : card.status === 'scanning' ? 'scanning' : 'unknown'}
				<div
					data-state={cardState}
					data-printing-state={card.printingState}
					data-finish={card.finish}
					class="bg-[var(--color-surface)] rounded-lg border p-4 {selectedCards.has(origIdx) ? 'ring-2 ring-green-500/50' : ''} {card.status === 'likely' || card.status === 'conflict' ? 'border-yellow-500/40' : 'border-[var(--color-border)]'}">
					<div class="flex flex-col sm:flex-row gap-4">
						<!-- Selection checkbox for importable cards -->
						{#if loggedIn && isImportable(card) && !addedCards.some(a => a.id === card.results[card.selectedResultIdx].id)}
							<div class="flex-shrink-0 pt-1">
								<input type="checkbox" checked={selectedCards.has(origIdx)} onchange={() => toggleSelect(origIdx)}
									class="w-5 h-5 rounded border-[var(--color-border)] accent-green-600 cursor-pointer" />
							</div>
						{/if}
						<!-- Debug: Cropped card + bottom scan -->
						<div class="flex-shrink-0 space-y-2">
							<CardPreview src={card.croppedUrl} alt="Card {origIdx + 1}" scale={1.5}>
								<img src={card.croppedUrl} alt="Card {origIdx + 1}" class="w-32 rounded" />
							</CardPreview>
							<div>
								<p class="text-xs text-[var(--color-text-muted)] mb-1">Name:</p>
								<CardPreview src={card.nameUrl} alt="Name scan {origIdx + 1}" maxWidth={600} maxHeight={150} contain>
									<img src={card.nameUrl} alt="Name scan {origIdx + 1}" class="w-32 rounded border border-[var(--color-border)]" />
								</CardPreview>
								{#if card.nameText}
									<p class="text-xs text-[var(--color-text-muted)] font-mono break-all w-32 mt-0.5">"{card.nameText}"</p>
								{/if}
							</div>
							<div>
								<p class="text-xs text-[var(--color-text-muted)] mb-1">Bottom:</p>
								<CardPreview src={card.bottomUrl} alt="Bottom scan {origIdx + 1}" maxWidth={600} maxHeight={200} contain>
									<img src={card.bottomUrl} alt="Bottom scan {origIdx + 1}" class="w-32 rounded border border-[var(--color-border)]" />
								</CardPreview>
								{#if card.ocrText}
									<p class="text-xs text-[var(--color-text-muted)] font-mono break-all w-32 mt-0.5">{card.ocrText.trim()}</p>
								{/if}
							</div>
						</div>

						<!-- Result -->
						<div class="flex-1">
							<h3 class="text-sm font-semibold mb-2 flex flex-wrap items-center gap-1">
								<span>Card {origIdx + 1}</span>
								{#if card.status === 'found'}
									<span class="text-xs px-1.5 py-0.5 rounded font-medium border bg-green-500/15 text-green-400 border-green-500/30">Confirmed</span>
									{#if card.results.length > 1 && card.printingState !== 'confirmed'}
										<span class="text-xs px-1.5 py-0.5 rounded font-medium border bg-yellow-500/15 text-yellow-300 border-yellow-500/30">Printing?</span>
									{/if}
								{:else if card.status === 'likely'}
									<span class="text-xs px-1.5 py-0.5 rounded font-medium border bg-yellow-500/15 text-yellow-300 border-yellow-500/30">Likely</span>
								{:else if card.status === 'conflict'}
									<span class="text-xs px-1.5 py-0.5 rounded font-medium border bg-red-500/15 text-red-400 border-red-500/30">Conflict</span>
								{:else if card.status === 'not_found'}
									<span class="text-xs px-1.5 py-0.5 rounded font-medium border bg-[var(--color-bg)] text-[var(--color-text-muted)] border-[var(--color-border)]">Unknown</span>
								{/if}
								<button
									onclick={() => cycleFinish(origIdx)}
									title="Finish: click to cycle unknown / foil / non-foil"
									class="text-xs px-1.5 py-0.5 rounded font-medium border transition-colors {card.finish === 'foil'
										? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/30'
										: card.finish === 'nonfoil'
											? 'bg-[var(--color-bg)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:border-[var(--color-text-muted)]'
											: 'bg-[var(--color-bg)] text-yellow-300 border-yellow-500/30 hover:border-yellow-400'}"
								>
									{card.finish === 'foil' ? 'FOIL' : card.finish === 'nonfoil' ? 'Non-Foil' : 'Finish?'}
								</button>
								{#if card.language && card.language !== 'EN'}
									<span class="text-xs px-1.5 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-text-muted)]">{card.language}</span>
								{/if}
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
							{:else if (card.status === 'found' || card.status === 'likely' || card.status === 'conflict') && card.results.length > 0}
								{#if card.status === 'likely'}
									<p class="text-xs text-yellow-300 mb-2">Probably this card — the name and the collector line only agree partially. Tap "Accept" or "Not this card".</p>
								{:else if card.status === 'conflict'}
									<p class="text-xs text-red-400 mb-2">The name and the collector line point at different cards. Pick the right one or search manually.</p>
								{:else if card.results.length > 1 && card.printingState !== 'confirmed'}
									<p class="text-xs text-yellow-300 mb-2">Several printings match — pick the right one before importing.</p>
								{/if}
								{#each card.results as result, rIdx}
									{@const imgSrc = getImageSrc(result)}
									{@const isAdded = addedCards.some((a) => a.id === result.id)}
									{@const isSelected = card.status === 'found' && rIdx === card.selectedResultIdx}
									{@const hasMultiple = card.results.length > 1}
									{@const offer = card.status === 'likely' || card.status === 'conflict'}
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<div
										onclick={() => { if (!offer && hasMultiple) { card.selectedResultIdx = rIdx; card.printingState = 'confirmed'; detectedCards = [...detectedCards]; } }}
										class="flex items-center gap-4 p-2 rounded-lg border transition-all
											{hasMultiple ? 'cursor-pointer' : ''}
											{isSelected
												? 'bg-[var(--color-bg)] border-[var(--color-primary)] ring-1 ring-[var(--color-primary)]'
												: hasMultiple
													? 'bg-[var(--color-bg)] border-[var(--color-border)] opacity-40 hover:opacity-70'
													: 'bg-[var(--color-bg)] border-[var(--color-border)]'}"
									>
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
										<PriceTag card={result as PriceFields} class="text-sm text-[var(--color-accent)]" />
										{#if offer}
											<button
												onclick={(e) => { e.stopPropagation(); acceptCandidate(origIdx, result); }}
												class="bg-yellow-600 hover:bg-yellow-700 px-3 py-1.5 rounded-lg text-sm transition-colors"
											>
												Accept
											</button>
										{:else if loggedIn && isSelected}
											{#if isAdded}
												<span class="text-green-400 text-sm w-20 text-center">Added!</span>
											{:else}
												<button
													onclick={(e) => { e.stopPropagation(); addToCollection(result.id as string, result.name as string, card.foil); }}
													disabled={adding === result.id}
													class="bg-green-600 hover:bg-green-700 px-4 py-1.5 rounded-lg text-sm transition-colors disabled:opacity-50"
												>
													{adding === result.id ? '...' : 'Add'}
												</button>
											{/if}
										{/if}
									</div>
								{/each}
								{#if card.status === 'likely' || card.status === 'conflict'}
									<button onclick={() => rejectCandidate(origIdx)}
										class="mt-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:underline">
										Not this card — search manually
									</button>
								{/if}
							{:else}
								<p class="text-sm text-[var(--color-text-muted)] mb-2">Not identified automatically.</p>
								{#if card.suggestions.length > 0}
									<p class="text-xs text-yellow-300 mb-1">Could be (collector number only, no name evidence):</p>
									{#each card.suggestions as sug}
										{@const sugImg = getImageSrc(sug)}
										<div class="flex items-center gap-3 p-2 mb-2 rounded-lg border border-yellow-500/30 bg-[var(--color-bg)]">
											{#if sugImg}
												<img src={sugImg} alt={sug.name as string} class="w-8 h-11 object-cover rounded" loading="lazy" />
											{/if}
											<div class="flex-1 min-w-0">
												<p class="text-sm font-medium truncate">{sug.name}</p>
												<p class="text-xs text-[var(--color-text-muted)]">{sug.set_name} ({(sug.set_code as string).toUpperCase()}) #{sug.collector_number}</p>
											</div>
											<button onclick={() => acceptCandidate(origIdx, sug)}
												class="bg-yellow-600 hover:bg-yellow-700 px-3 py-1 rounded-lg text-sm transition-colors">Accept</button>
										</div>
									{/each}
								{/if}
								{#if manualCardIndex === origIdx}
									<!-- Manual search form -->
									<div class="space-y-2">
										<div class="flex gap-2 text-xs">
											<button onclick={() => manualMode = 'set'}
												class="px-2 py-0.5 rounded border transition-colors {manualMode === 'set' ? 'bg-[var(--color-primary-button)] border-[var(--color-primary-button)] text-white' : 'border-[var(--color-border)]'}">
												Set + #
											</button>
											<button onclick={() => manualMode = 'name'}
												class="px-2 py-0.5 rounded border transition-colors {manualMode === 'name' ? 'bg-[var(--color-primary-button)] border-[var(--color-primary-button)] text-white' : 'border-[var(--color-border)]'}">
												Name
											</button>
										</div>
										{#if manualMode === 'set'}
											<form onsubmit={(e) => { e.preventDefault(); doManualSearch(); }} class="flex gap-2 items-end">
												<input type="text" bind:value={manualSetCode} placeholder="Set"
													class="w-20 bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-sm uppercase focus:outline-none focus:border-[var(--color-primary)]" />
												<input type="text" bind:value={manualNumber} placeholder="#"
													class="w-20 bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-sm focus:outline-none focus:border-[var(--color-primary)]" />
												<button type="submit" class="bg-[var(--color-primary-button)] px-3 py-1 rounded text-sm">Search</button>
											</form>
										{:else}
											<form onsubmit={(e) => { e.preventDefault(); doManualSearch(); }} class="flex gap-2">
												<input type="text" bind:value={manualQuery} placeholder="Card name..."
													class="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-sm focus:outline-none focus:border-[var(--color-primary)]" />
												<button type="submit" class="bg-[var(--color-primary-button)] px-3 py-1 rounded text-sm">Search</button>
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
														<PriceTag card={result as PriceFields} class="text-xs text-[var(--color-accent)]" />
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
									<button onclick={() => openManualSearch(origIdx)}
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

	<!-- Debug: Scanner Log -->
	{#if debugLog.length > 0}
		<details class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)]">
			<summary class="p-4 cursor-pointer text-sm font-semibold">
				Debugger ({debugLog.length} entries)
			</summary>
			<div class="p-4 pt-0">
				<button
					onclick={copyDebugLog}
					class="text-xs mb-3 px-3 py-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] hover:bg-[var(--color-surface-hover)] transition-colors"
				>
					{debugLogCopied ? 'Copied!' : 'Copy Log'}
				</button>
				<pre class="text-xs font-mono bg-[var(--color-bg)] p-3 rounded max-h-96 overflow-y-auto whitespace-pre-wrap break-all border border-[var(--color-border)]">{debugLog.join('\n')}</pre>
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
				class="bg-[var(--color-primary-button)] hover:bg-[var(--color-primary-button-hover)] px-4 py-2 rounded-lg text-sm transition-colors">
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
