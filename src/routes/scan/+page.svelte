<script lang="ts">
	import type { PageData } from './$types';
	import { formatPrice } from '$lib/utils';
	import CardPreview from '$lib/components/CardPreview.svelte';
	import { onMount, onDestroy } from 'svelte';
	import { loadOpenCV } from '$lib/scanner/opencv';
	import { getTesseractPool, setPoolParameters, recognizeBatch, recognizeDetailed, terminatePool } from '$lib/scanner/tesseract';
	import { parseCollectorInfo } from '$lib/scanner/parse';
	import { bestNameMatch } from '$lib/scanner/similarity';
	import { loadImage, orderCorners } from '$lib/scanner/geometry';
	import { detectFoilFromSeparator } from '$lib/scanner/foil';

	let { data }: { data: PageData } = $props();
	let loggedIn = $derived(!!data.user);

	// State
	let imagePreview = $state('');
	let scanning = $state(false);
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
		status: 'scanning' | 'found' | 'not_found';
		foil: boolean;
		selectedResultIdx: number;
	}>>([]);
	let debugCanvasUrl = $state('');
	let debugLog = $state<string[]>([]);
	let scanStartTime = 0;
	let debugLogCopied = $state(false);
	let adding = $state<string | null>(null);
	let addedCards = $state<Array<{ id: string; name: string }>>([]);
	let selectedCards = $state<Set<number>>(new Set());
	let importing = $state(false);
	// Two-mode selector replacing the old "expected card count" number input.
	// 'single' assumes exactly one card in the photo; 'multiple' lets the
	// detector return as many cards as it can find.
	let scanMode = $state<'single' | 'multiple'>('single');
	const expectedCardCount = $derived<number | null>(scanMode === 'single' ? 1 : null);

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
	});

	$effect(() => {
		try {
			localStorage.setItem('mtg-scan-vision-retry', String(visionRetryEnabled));
		} catch { /* localStorage unavailable */ }
	});

	// Terminate Tesseract workers when leaving the page. Each worker holds
	// ~50 MB of runtime + language data; without this the pool persists until
	// the tab closes even after a single scan.
	onDestroy(() => {
		terminatePool().catch(() => { /* already gone */ });
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

	async function processImage(file: File) {
		scanning = true;
		scanStartTime = performance.now();
		scanProgress = 'Loading OpenCV...';

		try {
			await loadOpenCV();
			const cv = (window as any).cv;
			log('OpenCV loaded');

			scanProgress = 'Detecting cards...';

			// Load image into canvas
			const img = await loadImage(file);
			const canvas = document.createElement('canvas');
			canvas.width = img.width;
			canvas.height = img.height;
			const ctx = canvas.getContext('2d')!;
			ctx.drawImage(img, 0, 0);

			log(`Image loaded: ${img.width}x${img.height} (${(img.width * img.height).toLocaleString()}px)`);
			log(`Mode: ${scanMode}, expectedCardCount: ${expectedCardCount ?? 'unlimited'}`);

			// OpenCV processing
			const src = cv.imread(canvas);
			const gray = new cv.Mat();

			cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

			type CardCandidate = { corners: any; area: number; rect: { x: number; y: number; width: number; height: number }; synthetic?: boolean };
			let allCandidates: CardCandidate[] = [];
			const imgArea = img.width * img.height;

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

			const minArea = imgArea * 0.008;
			const maxArea = imgArea * 0.5;
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
				cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
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
			let cardContours: CardCandidate[] = [];
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

			// === Progressive relaxation if expected card count not met ===
			if (expectedCardCount && cardContours.length < expectedCardCount) {
				log(`Progressive relaxation triggered (have ${cardContours.length}, need ${expectedCardCount})`);
				const relaxedMinArea = imgArea * 0.004;
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

			// === Grid inference: fill missing positions if cards form a grid ===
			if (expectedCardCount && cardContours.length < expectedCardCount && cardContours.length >= 3) {
				// Use bounding rect centers for grid layout (stable for upright cards)
				const gridRects = cardContours.map(c => c.rect);
				const gridCenters = gridRects.map(r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 }));

				// Median card dimensions from bounding rects
				const bws = gridRects.map(r => r.width).sort((a, b) => a - b);
				const bhs = gridRects.map(r => r.height).sort((a, b) => a - b);
				const medW = bws[Math.floor(bws.length / 2)];
				const medH = bhs[Math.floor(bhs.length / 2)];

				// Cluster into rows (by Y center) and columns (by X center)
				function cluster1D(values: number[], threshold: number): number[][] {
					const sorted = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
					const groups: number[][] = [[]];
					groups[0].push(sorted[0].i);
					for (let i = 1; i < sorted.length; i++) {
						if (sorted[i].v - sorted[i - 1].v > threshold) {
							groups.push([]);
						}
						groups[groups.length - 1].push(sorted[i].i);
					}
					return groups;
				}

				const rows = cluster1D(gridCenters.map(c => c.y), medH * 0.4);
				const cols = cluster1D(gridCenters.map(c => c.x), medW * 0.4);

				log(`Grid analysis: ${rows.length} rows x ${cols.length} cols detected`);
				if (rows.length >= 2 && cols.length >= 2 && rows.length * cols.length >= expectedCardCount * 0.8) {
					// Assign each card to a (row, col) index
					const cardGrid: { [key: string]: number } = {}; // "row,col" -> card index
					for (let ci = 0; ci < cardContours.length; ci++) {
						const rowIdx = rows.findIndex(r => r.includes(ci));
						const colIdx = cols.findIndex(c => c.includes(ci));
						if (rowIdx >= 0 && colIdx >= 0) {
							cardGrid[`${rowIdx},${colIdx}`] = ci;
						}
					}

					// For each empty cell, compute position from same-row and same-col neighbors
					for (let ri = 0; ri < rows.length; ri++) {
						for (let ci = 0; ci < cols.length; ci++) {
							if (cardContours.length >= expectedCardCount) break;
							if (cardGrid[`${ri},${ci}`] !== undefined) continue;

							// Get X from same-column neighbors (cards in column ci, any row)
							const colNeighbors = cols[ci].map(idx => gridCenters[idx].x);
							const inferX = colNeighbors.length > 0
								? colNeighbors.reduce((a, b) => a + b, 0) / colNeighbors.length
								: null;

							// Get Y from same-row neighbors (cards in row ri, any column)
							const rowNeighbors = rows[ri].map(idx => gridCenters[idx].y);
							const inferY = rowNeighbors.length > 0
								? rowNeighbors.reduce((a, b) => a + b, 0) / rowNeighbors.length
								: null;

							if (inferX === null || inferY === null) continue;

							// Use median bounding rect dimensions (not corner edge lengths)
							const x1 = Math.max(0, Math.round(inferX - medW / 2));
							const y1 = Math.max(0, Math.round(inferY - medH / 2));
							const x2 = Math.min(img.width - 1, x1 + medW);
							const y2 = Math.min(img.height - 1, y1 + medH);
							const corners = new cv.Mat(4, 1, cv.CV_32SC2);
							corners.data32S[0] = x1; corners.data32S[1] = y1;
							corners.data32S[2] = x2; corners.data32S[3] = y1;
							corners.data32S[4] = x2; corners.data32S[5] = y2;
							corners.data32S[6] = x1; corners.data32S[7] = y2;
							cardContours.push({
								corners,
								area: (x2 - x1) * (y2 - y1),
								rect: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
								synthetic: true
							});
						}
					}
				}
				log(`Grid inference: added synthetic cards, now ${cardContours.length} total`);
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
				blur5.delete(); sepKernel5.delete(); dilateKernel3.delete();
				return;
			}

			log(`Detection complete: ${cardContours.length} card(s) found`);
			scanProgress = `Found ${cardContours.length} card(s). Reading...`;

			// Process each detected card
			const cards: typeof detectedCards = [];
			// Bottom canvases kept outside $state so Svelte doesn't try to proxy
			// HTMLCanvasElement instances. Used for pixel-based foil detection
			// in single-card mode after OCR completes.
			const bottomCanvases: HTMLCanvasElement[] = [];

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
						return [
							Math.max(0, Math.min(img.width - 1, Math.round(x + (dx / dist) * expand))),
							Math.max(0, Math.min(img.height - 1, Math.round(y + (dy / dist) * expand)))
						] as [number, number];
					}) as Array<[number, number]>;
				}

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

				// Crop name area — skip black border + frame top, capture name text line
				// Expanded cards have ~7-8% border at top; synthetic cards have less (~3%)
				const nameY = Math.floor(cardH * (cardContours[i].synthetic ? 0.03 : 0.07));
				const nameH = Math.floor(cardH * (cardContours[i].synthetic ? 0.08 : 0.065));
				const nameW = Math.floor(cardW * 0.72);
				log(`Card ${i + 1}: name crop y=${nameY} h=${nameH} w=${nameW}`);
				const nameRoi = warped.roi(new cv.Rect(Math.floor(cardW * 0.08), nameY, nameW, nameH));
				const grayName = new cv.Mat();
				cv.cvtColor(nameRoi, grayName, cv.COLOR_RGBA2GRAY);
				const nameScaled = new cv.Mat();
				cv.resize(grayName, nameScaled, new cv.Size(nameW * 6, nameH * 6), 0, 0, cv.INTER_CUBIC);
				const nameCanvas = document.createElement('canvas');
				cv.imshow(nameCanvas, nameScaled);
				const nameUrl = nameCanvas.toDataURL();
				nameRoi.delete(); grayName.delete(); nameScaled.delete();

				// Crop bottom strip for collector info (left half only, right has copyright)
				const bottomY = Math.floor(cardH * 0.90);
				const bottomH = Math.floor(cardH * 0.07);
				log(`Card ${i + 1}: bottom crop y=${bottomY} h=${bottomH} w=${Math.floor(cardW * 0.5)}`);
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
				bottomCanvases.push(bottomCanvas);

				cards.push({
					index: i,
					croppedUrl,
					nameUrl,
					bottomUrl,
					nameText: '',
					ocrText: '',
					setCode: '',
					collectorNumber: '',
					results: [],
					matchType: '',
					status: 'scanning',
					foil: false,
					selectedResultIdx: 0
				});

				// Cleanup card-specific mats
				srcPts.delete(); dstPts.delete(); M.delete(); warped.delete();
				bottomRoi.delete(); scaled.delete();
				pts.delete();
			}

			detectedCards = cards;

			// Cleanup OpenCV mats
			src.delete(); gray.delete();
			blur5.delete(); sepKernel5.delete(); dilateKernel3.delete();

			// === Name-first OCR approach ===
			// Phase 1: OCR name areas with Tesseract in parallel across a worker pool.
			// Sequential recognition was the single biggest wall-clock bottleneck —
			// a 10-card scan spent ~5s here.
			const pool = await getTesseractPool();
			log(`Phase 1: Name OCR (Tesseract PSM 7, ${pool.length} workers in parallel)`);
			await setPoolParameters(pool, {
				tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ',-.",
				tessedit_pageseg_mode: '7' // single text line
			});

			const nameUrls = detectedCards.map((c) => c.nameUrl);
			const nameTexts = await recognizeBatch(pool, nameUrls, (done, total) => {
				scanProgress = `Reading names ${done}/${total}...`;
			});
			for (let i = 0; i < detectedCards.length; i++) {
				detectedCards[i].nameText = nameTexts[i].replace(/[\r\n]+/g, ' ').trim();
				log(`Card ${i + 1} name OCR: "${detectedCards[i].nameText}"`);
			}
			detectedCards = [...detectedCards];

			// Phase 2: Batch-search all names server-side in a single round trip.
			// Previously this was 1+ fetch per card (and a second fetch per word
			// fallback), which dominated wall-clock time at low network latency.
			log('Phase 2: Name search in DB (batched)');

			const namesToSearch: Array<{ cardIdx: number; cleanName: string }> = [];
			for (let i = 0; i < detectedCards.length; i++) {
				const card = detectedCards[i];
				if (!card.nameText || card.nameText.length < 2) {
					log(`Card ${i + 1}: name too short or empty, skipping search`);
					continue;
				}
				const cleanName = card.nameText.replace(/^[^A-Za-z]+/, '').trim();
				namesToSearch.push({ cardIdx: i, cleanName });
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
					const best = bestNameMatch(searchData.results, cleanName);
					log(`Card ${cardIdx + 1}: best match "${best.name}" score=${best.score.toFixed(3)} (threshold=0.6)`);
					if (best.score >= 0.6) {
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
					const best = bestNameMatch(wData.results, cleanName);
					log(`Card ${cardIdx + 1}: word best match "${best.name}" score=${best.score.toFixed(3)}`);
					if (best.score >= 0.6) {
						card.results = wData.results.filter((r: Record<string, unknown>) => r.name === best.name);
						card.matchType = 'similarity';
						log(`Card ${cardIdx + 1}: word fallback accepted "${best.name}" -> ${card.results.length} reprints`);
					}
				}
			}
			detectedCards = [...detectedCards];

			// Phase 3: OCR bottom areas for disambiguation + foil detection
			await setPoolParameters(pool, {
				tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .*#/&',
				tessedit_pageseg_mode: '6'
			});

			const langs = 'EN|DE|FR|IT|ES|JA|PT|RU|ZH|KO';

			// Populated via a pre-pass before the applyBottomMatch loop so the
			// set+number fallback doesn't round-trip the server once per card.
			// Key: "setCode|collectorNumber". Lookups populated here short-circuit
			// the per-card fetch inside applyBottomMatch.
			const setNumCache = new Map<string, { results: Record<string, unknown>[]; matchType: string }>();
			const setNumKey = (s: string, n: string) => `${s.toLowerCase()}|${n}`;

			async function prefetchSetNumberLookups(cards: typeof detectedCards) {
				const seen = new Set<string>();
				const lookups: Array<{ setCode: string; collectorNumber: string }> = [];
				for (const card of cards) {
					if (card.nameText || card.results.length > 0) continue;
					const parsed = parseCollectorInfo(card.ocrText, langs);
					if (!parsed.setCode || !parsed.collectorNumber) continue;
					const key = setNumKey(parsed.setCode, parsed.collectorNumber);
					if (seen.has(key) || setNumCache.has(key)) continue;
					seen.add(key);
					lookups.push({ setCode: parsed.setCode, collectorNumber: parsed.collectorNumber });
				}
				if (lookups.length === 0) return;
				log(`Phase 3 pre-pass: batching ${lookups.length} set+number lookup(s)`);
				try {
					const res = await fetch('/scan', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ lookups })
					});
					const data = await res.json();
					const batch = Array.isArray(data?.batch) ? data.batch : [];
					for (const entry of batch) {
						setNumCache.set(setNumKey(entry.setCode, entry.collectorNumber), {
							results: entry.results ?? [],
							matchType: entry.matchType ?? 'set_number'
						});
					}
				} catch (err) {
					log(`Phase 3 pre-pass batch error: ${err}`);
				}
			}

			// Re-run set/number parsing + reprint disambiguation for a single card
			// using whatever is currently in card.ocrText. Used both after the
			// Tesseract pass (trustFoilChar=false) and after Google Vision retry
			// (trustFoilChar=true). Tesseract routinely misreads the bullet
			// separator • as * at small sizes, so we can't trust its foil hint
			// for non-foil cards — card.foil is only set from OCR text when the
			// upstream engine distinguishes the two symbols reliably.
			async function applyBottomMatch(
				card: typeof detectedCards[number],
				cardIdx: number,
				trustFoilChar: boolean
			) {
				const parsed = parseCollectorInfo(card.ocrText, langs, (msg) => log(`Card ${cardIdx}: ${msg}`));
				card.setCode = parsed.setCode;
				card.collectorNumber = parsed.collectorNumber;

				if (trustFoilChar) {
					card.foil = parsed.foilFromText;
					log(`Card ${cardIdx}: parsed set="${parsed.setCode}" num="${parsed.collectorNumber}" foil=${parsed.foilFromText} (trusted)`);
				} else {
					// Tesseract — never auto-flip foil; user toggles manually if needed.
					card.foil = false;
					log(`Card ${cardIdx}: parsed set="${parsed.setCode}" num="${parsed.collectorNumber}" (foil hint "${parsed.foilFromText}" ignored — Tesseract * / . misread)`);
				}

				if (card.results.length === 1) {
					// Unique card from name search — done
					log(`Card ${cardIdx}: unique name match -> found`);
					card.status = 'found';
				} else if (card.results.length > 1) {
					// Multiple reprints — match known collector numbers/set codes against bottom text
					let match: Record<string, unknown> | undefined;
					const bottomText = card.ocrText;

					// Extract all digit sequences from bottom text for matching
					const digitSeqs = [...bottomText.matchAll(/\d+/g)].map(m => m[0]);
					log(`Card ${cardIdx}: ${card.results.length} reprints to disambiguate, digit sequences: [${digitSeqs.join(', ')}]`);

					// 1. Try matching known collector numbers in bottom text
					const numMatches = card.results.filter(r => {
						const cn = String(r.collector_number);
						const cnPadded = cn.padStart(3, '0');
						// Check exact match or if collector number is contained in a digit sequence
						// e.g. "8202" contains "202", "0188" contains "188"
						return digitSeqs.some(d =>
							d === cn || d === cnPadded ||
							d.replace(/^0+/, '') === cn ||
							d === cn.padStart(4, '0') ||
							d.includes(cn) || d.includes(cnPadded)
						);
					});
					log(`Card ${cardIdx}: collector number matching -> ${numMatches.length} matches`);
					if (numMatches.length === 1) {
						match = numMatches[0];
						log(`Card ${cardIdx}: unique number match: ${match.set_code}#${match.collector_number}`);
					}

					// 2. Try set code + collector number from generic parser
					if (!match && card.setCode && card.collectorNumber) {
						match = card.results.find(r =>
							(r.set_code as string).toLowerCase() === card.setCode.toLowerCase() &&
							(String(r.collector_number) === card.collectorNumber ||
							 String(r.collector_number) === card.collectorNumber.replace(/^0+/, ''))
						);
						log(`Card ${cardIdx}: set+number match (${card.setCode}#${card.collectorNumber}) -> ${match ? 'found' : 'none'}`);
					}

					// 3. Try just set code from generic parser
					if (!match && card.setCode) {
						const setMatches = card.results.filter(r => (r.set_code as string).toLowerCase() === card.setCode.toLowerCase());
						if (setMatches.length === 1) match = setMatches[0];
						log(`Card ${cardIdx}: set-only match (${card.setCode}) -> ${setMatches.length} matches`);
					}

					if (match) {
						card.results = [match];
						card.matchType = 'reprint_match';
						log(`Card ${cardIdx}: reprint resolved to ${match.set_code}#${match.collector_number}`);
					} else {
						log(`Card ${cardIdx}: could not disambiguate reprints, showing all ${card.results.length}`);
					}
					card.status = 'found';
				} else if (card.setCode && card.collectorNumber && !card.nameText) {
					// Name OCR completely failed — try set+number directly (old fallback).
					// Common case: the batch pre-pass populated setNumCache, so this
					// short-circuits without a network hit. Vision-retry path falls
					// through to a per-card fetch since it's rare and post-batch.
					log(`Card ${cardIdx}: no name, trying set+number fallback (${card.setCode}#${card.collectorNumber})`);
					const cached = setNumCache.get(setNumKey(card.setCode, card.collectorNumber));
					if (cached) {
						card.results = cached.results;
						card.matchType = cached.matchType;
						card.status = card.results.length > 0 ? 'found' : 'not_found';
						log(`Card ${cardIdx}: set+number fallback (cached) -> ${card.results.length} results, status=${card.status}`);
					} else {
						try {
							const res = await fetch('/scan', {
								method: 'POST',
								headers: { 'Content-Type': 'application/json' },
								body: JSON.stringify({ setCode: card.setCode, collectorNumber: card.collectorNumber })
							});
							const searchData = await res.json();
							card.results = searchData.results;
							card.matchType = searchData.matchType || 'set_number';
							card.status = card.results.length > 0 ? 'found' : 'not_found';
							log(`Card ${cardIdx}: set+number fallback -> ${card.results.length} results, status=${card.status}`);
						} catch { card.status = 'not_found'; }
					}
				} else {
					log(`Card ${cardIdx}: no match possible -> not_found`);
					card.status = 'not_found';
				}
			}

			// Phase 3a: Batch Tesseract bottom OCR across the worker pool, then
			// run the (fast, in-memory) matching pass sequentially afterwards.
			log(`Phase 3: Bottom OCR + disambiguation (Tesseract PSM 6, ${pool.length} workers)`);
			const bottomUrls = detectedCards.map((c) => c.bottomUrl);
			const bottomTexts = await recognizeBatch(pool, bottomUrls, (done, total) => {
				scanProgress = `OCR bottom ${done}/${total}...`;
			});
			for (let i = 0; i < detectedCards.length; i++) {
				detectedCards[i].ocrText = bottomTexts[i].replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
				log(`Card ${i + 1} bottom OCR: "${detectedCards[i].ocrText}"`);
			}
			await prefetchSetNumberLookups(detectedCards);
			for (let i = 0; i < detectedCards.length; i++) {
				scanProgress = `Matching card ${i + 1}/${detectedCards.length}...`;
				await applyBottomMatch(detectedCards[i], i + 1, false);
			}

			// Pixel-based foil detection — only for single-card mode where the
			// bottom strip is large enough to reliably sample the separator.
			// Multi-card scans skip this (per-card resolution too low).
			if (scanMode === 'single' && detectedCards.length === 1 && bottomCanvases[0]) {
				const card = detectedCards[0];
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
						card.foil = foilResult.foil;
						log(`Card 1: pixel foil detection -> foil=${foilResult.foil} (bright=${(foilResult.brightRatio * 100).toFixed(1)}%)`);
					}
				}
			}
			detectedCards = [...detectedCards];

			// Phase 3b: Optional Google Vision retry. If the user has stored a personal
			// API key in /settings AND the toggle on this page is enabled, re-OCR any
			// cards that Tesseract could not identify (status === 'not_found') or
			// could not narrow down to a single reprint (results.length > 1), then
			// re-run the matching logic with the higher-quality Vision text.
			const userHasVisionKey = !!data.user?.hasVisionApiKey;
			if (userHasVisionKey && visionRetryEnabled) {
				const failed: Array<{ card: typeof detectedCards[number]; index: number }> = [];
				for (let i = 0; i < detectedCards.length; i++) {
					const c = detectedCards[i];
					if (c.status === 'not_found' || c.results.length > 1) {
						failed.push({ card: c, index: i });
					}
				}

				if (failed.length > 0) {
					log(`Phase 3b: Vision retry for ${failed.length} card(s) [${failed.map(f => `Card ${f.index + 1}`).join(', ')}]`);
					// /api/ocr accepts up to 16 images per request — chunk if needed.
					for (let batchStart = 0; batchStart < failed.length; batchStart += 16) {
						const batch = failed.slice(batchStart, batchStart + 16);
						scanProgress = `Retrying ${batch.length} card${batch.length === 1 ? '' : 's'} with Google Vision...`;
						try {
							const res = await fetch('/api/ocr', {
								method: 'POST',
								headers: { 'Content-Type': 'application/json' },
								body: JSON.stringify({ images: batch.map(({ card }) => card.bottomUrl) })
							});
							if (res.ok) {
								const visionData = await res.json();
								for (let j = 0; j < batch.length; j++) {
									const newText = (visionData.results?.[j] ?? '').toString();
									if (!newText) continue;
									const { card, index: cardIdx } = batch[j];
									const oldText = card.ocrText;
									card.ocrText = newText;
									log(`Card ${cardIdx + 1}: Vision text="${newText}" (Tesseract was="${oldText}")`);
									await applyBottomMatch(card, cardIdx + 1, true);
									visionRetriedCount++;
									log(`Card ${cardIdx + 1}: after Vision retry -> status=${card.status}, results=${card.results.length}`);
								}
								detectedCards = [...detectedCards];
							}
						} catch { /* keep Tesseract result for this batch */ }
					}
				} else {
					log('Phase 3b: Vision retry skipped (no failed cards)');
				}
			} else {
				log(`Phase 3b: Vision retry ${!userHasVisionKey ? 'no API key' : 'disabled by toggle'}`);
			}

			const identifiedCount = detectedCards.filter((c) => c.status === 'found').length;
			log(`Scan complete: ${identifiedCount}/${detectedCards.length} identified`);
			scanProgress = `Done! ${identifiedCount} of ${detectedCards.length} identified.`;
		} catch (err) {
			scanProgress = `Error: ${(err as Error).message}`;
		} finally {
			scanning = false;
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
			if (card.status === 'found' && card.results.length > 0) {
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
			if (card.status === 'found' && card.results.length > 0) {
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
	{:else if scanProgress && imagePreview}
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
		{@const identifiedCount = detectedCards.filter(c => c.status === 'found' && c.results.length > 0 && !addedCards.some(a => a.id === c.results[c.selectedResultIdx].id)).length}
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
				<div class="bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] p-4 {selectedCards.has(origIdx) ? 'ring-2 ring-green-500/50' : ''}">
					<div class="flex flex-col sm:flex-row gap-4">
						<!-- Selection checkbox for identified cards -->
						{#if loggedIn && card.status === 'found' && card.results.length > 0 && !addedCards.some(a => a.id === card.results[card.selectedResultIdx].id)}
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
							<h3 class="text-sm font-semibold mb-2">
								Card {origIdx + 1}
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
								{#each card.results as result, rIdx}
									{@const imgSrc = getImageSrc(result)}
									{@const isAdded = addedCards.some((a) => a.id === result.id)}
									{@const isSelected = rIdx === card.selectedResultIdx}
									{@const hasMultiple = card.results.length > 1}
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<div
										onclick={() => { if (hasMultiple) { card.selectedResultIdx = rIdx; detectedCards = [...detectedCards]; } }}
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
										<span class="text-sm text-[var(--color-accent)]">{formatPrice(result.price_eur as number | null, result.price_usd as number | null)}</span>
										{#if loggedIn && isSelected}
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
							{:else}
								<p class="text-sm text-[var(--color-text-muted)] mb-2">Not identified automatically.</p>
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
