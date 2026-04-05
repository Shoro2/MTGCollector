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
	let adding = $state<string | null>(null);
	let addedCards = $state<Array<{ id: string; name: string }>>([]);
	let selectedCards = $state<Set<number>>(new Set());
	let importing = $state(false);
	let expectedCardCount = $state<number | null>(null);

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

			for (const params of cannyParams) {
				const blurMat = new cv.Mat();
				const edgeMat = new cv.Mat();
				cv.GaussianBlur(gray, blurMat, new cv.Size(params.blur, params.blur), 0);
				cv.Canny(blurMat, edgeMat, params.low, params.high);

				const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
				cv.dilate(edgeMat, edgeMat, kernel);

				findCardContours(edgeMat, minArea, maxArea);

				blurMat.delete(); edgeMat.delete(); kernel.delete();
			}

			// === Strategy 2: Threshold segmentation for tightly packed cards ===
			const blurForThresh = new cv.Mat();
			cv.GaussianBlur(gray, blurForThresh, new cv.Size(5, 5), 0);
			const threshMat = new cv.Mat();
			cv.adaptiveThreshold(blurForThresh, threshMat, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 51, -5);

			const sepKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
			cv.erode(threshMat, threshMat, sepKernel);
			cv.dilate(threshMat, threshMat, sepKernel);

			findCardContours(threshMat, minArea, maxArea);

			blurForThresh.delete(); threshMat.delete(); sepKernel.delete();

			// === Strategy 3: Histogram equalization + Canny for low-contrast cards ===
			const eqHist = new cv.Mat();
			cv.equalizeHist(gray, eqHist);
			const eqBlur = new cv.Mat();
			cv.GaussianBlur(eqHist, eqBlur, new cv.Size(5, 5), 0);
			const eqEdge = new cv.Mat();
			cv.Canny(eqBlur, eqEdge, 40, 120);
			const eqKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
			cv.dilate(eqEdge, eqEdge, eqKernel);

			findCardContours(eqEdge, minArea, maxArea);

			eqHist.delete(); eqBlur.delete(); eqEdge.delete(); eqKernel.delete();

			// === Strategy 4: Otsu global threshold ===
			const otsuBlur = new cv.Mat();
			cv.GaussianBlur(gray, otsuBlur, new cv.Size(5, 5), 0);
			const otsuMat = new cv.Mat();
			cv.threshold(otsuBlur, otsuMat, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

			const otsuSepKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
			cv.erode(otsuMat, otsuMat, otsuSepKernel);
			cv.dilate(otsuMat, otsuMat, otsuSepKernel);

			findCardContours(otsuMat, minArea, maxArea);

			otsuBlur.delete(); otsuMat.delete(); otsuSepKernel.delete();

			// === Strategy 5: Color saturation mask ===
			// Cards have colored frames/art that are more saturated than a plain background.
			// This helps detect light-bordered cards that blend with the background in grayscale.
			const hsv = new cv.Mat();
			cv.cvtColor(src, hsv, cv.COLOR_RGBA2RGB);
			const hsvMat = new cv.Mat();
			cv.cvtColor(hsv, hsvMat, cv.COLOR_RGB2HSV);
			hsv.delete();

			const channels = new cv.MatVector();
			cv.split(hsvMat, channels);
			const saturation = channels.get(1);
			hsvMat.delete();

			// Threshold on saturation — cards with colored borders will have higher saturation
			const satThresh = new cv.Mat();
			cv.threshold(saturation, satThresh, 30, 255, cv.THRESH_BINARY);

			// Morphological close to fill gaps within cards, then erode to separate
			const satCloseKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15));
			cv.morphologyEx(satThresh, satThresh, cv.MORPH_CLOSE, satCloseKernel);
			const satSepKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
			cv.erode(satThresh, satThresh, satSepKernel);
			cv.dilate(satThresh, satThresh, satSepKernel);

			findCardContours(satThresh, minArea, maxArea);

			saturation.delete(); satThresh.delete();
			satCloseKernel.delete(); satSepKernel.delete();
			channels.delete();

			// === Strategy 6: Inverted Otsu for light cards on light backgrounds ===
			// Some cards (lands with light borders) blend with white backgrounds.
			// Inverted threshold can catch them.
			const invOtsuBlur = new cv.Mat();
			cv.GaussianBlur(gray, invOtsuBlur, new cv.Size(5, 5), 0);
			const invOtsuMat = new cv.Mat();
			cv.threshold(invOtsuBlur, invOtsuMat, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

			const invSepKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
			cv.erode(invOtsuMat, invOtsuMat, invSepKernel);
			cv.dilate(invOtsuMat, invOtsuMat, invSepKernel);

			findCardContours(invOtsuMat, minArea, maxArea);

			invOtsuBlur.delete(); invOtsuMat.delete(); invSepKernel.delete();

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

			// === Size consistency filter: remove detections much smaller than median ===
			// This catches text-block false positives (e.g. only the text area of a card detected)
			if (cardContours.length >= 3) {
				const areas = cardContours.map(c => c.area).sort((a, b) => a - b);
				const medianArea = areas[Math.floor(areas.length / 2)];
				cardContours = cardContours.filter(c => c.area >= medianArea * 0.4);
			}

			// === Progressive relaxation if expected card count not met ===
			if (expectedCardCount && cardContours.length < expectedCardCount) {
				const relaxedMinArea = imgArea * 0.004;
				const relaxedMinAspect = 0.4;
				const relaxedMaxAspect = 0.95;

				// Re-run Canny with relaxed params
				for (const params of [{ blur: 5, low: 20, high: 80 }, { blur: 7, low: 30, high: 100 }]) {
					const blurMat = new cv.Mat();
					const edgeMat = new cv.Mat();
					cv.GaussianBlur(gray, blurMat, new cv.Size(params.blur, params.blur), 0);
					cv.Canny(blurMat, edgeMat, params.low, params.high);

					const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
					cv.dilate(edgeMat, edgeMat, kernel);

					findCardContours(edgeMat, relaxedMinArea, maxArea, relaxedMinAspect, relaxedMaxAspect);

					blurMat.delete(); edgeMat.delete(); kernel.delete();
				}

				// Re-run adaptive threshold with different params
				const relaxBlur = new cv.Mat();
				cv.GaussianBlur(gray, relaxBlur, new cv.Size(5, 5), 0);
				const relaxThresh = new cv.Mat();
				cv.adaptiveThreshold(relaxBlur, relaxThresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 31, -3);

				const relaxSep = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
				cv.erode(relaxThresh, relaxThresh, relaxSep);
				cv.dilate(relaxThresh, relaxThresh, relaxSep);

				findCardContours(relaxThresh, relaxedMinArea, maxArea, relaxedMinAspect, relaxedMaxAspect);

				relaxBlur.delete(); relaxThresh.delete(); relaxSep.delete();

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

			// === Name-first OCR approach ===
			// Phase 1: OCR name areas with Tesseract (large text = high accuracy)
			const worker = await getTesseractWorker();
			await worker.setParameters({
				tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ',-.",
				tessedit_pageseg_mode: '7' // single text line
			});

			for (let i = 0; i < detectedCards.length; i++) {
				scanProgress = `Reading name ${i + 1}/${detectedCards.length}...`;
				const card = detectedCards[i];
				try {
					const result = await worker.recognize(card.nameUrl);
					card.nameText = result.data.text.replace(/[\r\n]+/g, ' ').trim();
				} catch { card.nameText = ''; }
				detectedCards = [...detectedCards];
			}

			// Phase 2: Search DB by name → get all reprints
			for (let i = 0; i < detectedCards.length; i++) {
				const card = detectedCards[i];
				if (!card.nameText || card.nameText.length < 2) continue;

				// Only strip leading non-letter junk (OCR artifacts)
				// Don't remove trailing chars — similarity scoring handles OCR noise
				let cleanName = card.nameText
					.replace(/^[^A-Za-z]+/, '')
					.trim();

				scanProgress = `Searching "${cleanName}"...`;
				try {
					const res = await fetch('/scan', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ query: cleanName })
					});
					const searchData = await res.json();
					if (searchData.results.length > 0) {
						// Pick best matching name by similarity score
						const best = bestNameMatch(searchData.results, cleanName);
						if (best.score >= 0.6) {
							card.results = searchData.results.filter((r: Record<string, unknown>) => r.name === best.name);
							card.matchType = searchData.matchType;
						}
					}

					// Fallback: search by longest word if full name didn't match well
					if (card.results.length === 0) {
						const words = cleanName.split(/\s+/).filter(w => w.length >= 3);
						// Try longest word first (most distinctive)
						words.sort((a, b) => b.length - a.length);
						for (const word of words.slice(0, 2)) {
							const wRes = await fetch('/scan', {
								method: 'POST',
								headers: { 'Content-Type': 'application/json' },
								body: JSON.stringify({ query: word })
							});
							const wData = await wRes.json();
							if (wData.results.length > 0) {
								const best = bestNameMatch(wData.results, cleanName);
								if (best.score >= 0.6) {
									card.results = wData.results.filter((r: Record<string, unknown>) => r.name === best.name);
									card.matchType = 'similarity';
									break;
								}
							}
						}
					}
				} catch { /* */ }
				detectedCards = [...detectedCards];
			}

			// Phase 3: OCR bottom areas for disambiguation + foil detection
			await worker.setParameters({
				tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .*#/&',
				tessedit_pageseg_mode: '6'
			});

			// Google Vision batch for bottom text if 5+ cards
			const useGoogleVision = detectedCards.length >= 5;
			let visionBottomTexts: string[] = [];

			if (useGoogleVision) {
				scanProgress = `Reading card details with Google Vision...`;
				try {
					const res = await fetch('/api/ocr', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ images: detectedCards.map(c => c.bottomUrl) })
					});
					if (res.ok) {
						const visionData = await res.json();
						visionBottomTexts = visionData.results;
					}
				} catch { /* fallback to Tesseract */ }
			}

			const langs = 'EN|DE|FR|IT|ES|JA|PT|RU|ZH|KO';

			for (let i = 0; i < detectedCards.length; i++) {
				const card = detectedCards[i];
				scanProgress = `Matching card ${i + 1}/${detectedCards.length}...`;

				// OCR bottom text
				let tesseractWords: any[] | null = null;
				if (visionBottomTexts.length > i) {
					card.ocrText = visionBottomTexts[i];
				} else {
					try {
						const result = await worker.recognize(card.bottomUrl);
						card.ocrText = result.data.text.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
						tesseractWords = result.data.words;
					} catch { card.ocrText = ''; }
				}

				// Parse set code + collector number from bottom
				const parsed = parseCollectorInfo(card.ocrText, langs);
				card.setCode = parsed.setCode;
				card.collectorNumber = parsed.collectorNumber;

				// Foil detection from separator char (* = foil, . = non-foil)
				card.foil = parsed.foilFromText;

				if (card.results.length === 1) {
					// Unique card from name search — done
					card.status = 'found';
				} else if (card.results.length > 1) {
					// Multiple reprints — match known collector numbers/set codes against bottom text
					let match: Record<string, unknown> | undefined;
					const bottomText = card.ocrText;

					// Extract all digit sequences from bottom text for matching
					const digitSeqs = [...bottomText.matchAll(/\d+/g)].map(m => m[0]);

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
					if (numMatches.length === 1) match = numMatches[0];

					// 2. Try set code + collector number from generic parser
					if (!match && card.setCode && card.collectorNumber) {
						match = card.results.find(r =>
							(r.set_code as string).toLowerCase() === card.setCode.toLowerCase() &&
							(String(r.collector_number) === card.collectorNumber ||
							 String(r.collector_number) === card.collectorNumber.replace(/^0+/, ''))
						);
					}

					// 3. Try just set code from generic parser
					if (!match && card.setCode) {
						const setMatches = card.results.filter(r => (r.set_code as string).toLowerCase() === card.setCode.toLowerCase());
						if (setMatches.length === 1) match = setMatches[0];
					}

					if (match) {
						card.results = [match];
						card.matchType = 'reprint_match';
					}
					card.status = 'found';
				} else if (card.setCode && card.collectorNumber && !card.nameText) {
					// Name OCR completely failed — try set+number directly (old fallback)
					// Only when nameText is empty, never override a name match
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
					} catch { card.status = 'not_found'; }
				} else {
					card.status = 'not_found';
				}

				detectedCards = [...detectedCards];
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
		const anchor = new RegExp(`\\b([A-Z]{3})\\s*([^A-Za-z0-9\\s]?)\\s*(?:${langs})\\b`, 'i');
		const anchorMatch = text.match(anchor);

		if (anchorMatch) {
			result.setCode = anchorMatch[1].toLowerCase();

			// Check separator character for foil hint
			const sep = anchorMatch[2] || '';
			result.foilFromText = /[*#&]/.test(sep);

			// Step 2: Extract collector number from text BEFORE the set code
			const before = text.substring(0, anchorMatch.index);

			// Handle fraction format first (Era 3): "010/277"
			const fractionMatch = before.match(/([\dOoIilJjBbSsZz]{1,4})\/([\dOoIilJjBbSsZz]{1,4})/);
			if (fractionMatch) {
				result.collectorNumber = stripLeadingZeros(fixOcrDigits(fractionMatch[1]));
			} else {
				// Strategy: find the collector number near the end of `before`.
				// It may be split by spaces/OCR errors: "C 0 045" or "0045" or "024 J"
				// Take the last ~20 chars before the set code and extract all digit-like content
				const tail = before.slice(-20).trim();

				// Try to find a rarity+number pattern: "C 0045", "R 024 J", "M0085"
				const rarityNumMatch = tail.match(/[CURM]\s*([\d\s]{1,8}[JjIil|!)Oo]?)\s*$/i);
				if (rarityNumMatch) {
					const fixed = fixOcrDigits(rarityNumMatch[1].replace(/\s/g, ''));
					if (fixed.length > 0 && fixed.length <= 4) {
						result.collectorNumber = stripLeadingZeros(fixed);
					}
				}

				// Fallback: just find the last digit sequence
				if (!result.collectorNumber) {
					const allDigits = [...before.matchAll(/\d{1,4}/g)];
					if (allDigits.length > 0) {
						const lastMatch = allDigits[allDigits.length - 1];
						let raw = lastMatch[0];
						const afterIdx = (lastMatch.index ?? 0) + raw.length;
						const after = before.substring(afterIdx).replace(/^\s+/, '');
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

		// Foil fallback: if anchor didn't match, check for * anywhere in text
		// The star/bullet separator is distinctive enough as a foil indicator
		if (!result.foilFromText && text.includes('*')) {
			result.foilFromText = true;
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

	// Normalized similarity score (0-1) based on Levenshtein distance
	function similarity(a: string, b: string): number {
		const al = a.toLowerCase();
		const bl = b.toLowerCase();
		if (al === bl) return 1;
		const maxLen = Math.max(al.length, bl.length);
		if (maxLen === 0) return 1;

		// Levenshtein distance via dynamic programming
		const prev = Array.from({ length: bl.length + 1 }, (_, i) => i);
		for (let i = 1; i <= al.length; i++) {
			let prevDiag = prev[0];
			prev[0] = i;
			for (let j = 1; j <= bl.length; j++) {
				const temp = prev[j];
				prev[j] = al[i - 1] === bl[j - 1]
					? prevDiag
					: 1 + Math.min(prev[j], prev[j - 1], prevDiag);
				prevDiag = temp;
			}
		}
		return 1 - prev[bl.length] / maxLen;
	}

	// Pick best matching card name from results by similarity score
	function bestNameMatch(results: Array<Record<string, unknown>>, query: string): { name: string; score: number } {
		let bestName = '';
		let bestScore = 0;
		const seen = new Set<string>();
		for (const r of results) {
			const name = r.name as string;
			if (seen.has(name)) continue;
			seen.add(name);
			const score = similarity(query, name);
			if (score > bestScore) {
				bestScore = score;
				bestName = name;
			}
		}
		return { name: bestName, score: bestScore };
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
	<title>MTG Card Scanner - Scan & Identify Cards | MTG Collector</title>
	<meta name="description" content="Scan Magic: The Gathering cards with your camera. Automatic card detection, OCR recognition, foil detection, and price lookup." />
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
		<label class="flex items-center gap-2 mt-2">
			<span class="text-xs text-[var(--color-text-muted)]">Expected number of cards (optional):</span>
			<input
				type="number"
				min="1"
				max="50"
				placeholder="-"
				class="w-16 px-2 py-1 text-xs rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)]"
				oninput={(e) => {
					const val = parseInt((e.target as HTMLInputElement).value);
					expectedCardCount = isNaN(val) ? null : val;
				}}
			/>
		</label>
		<p class="text-xs text-[var(--color-text-muted)] mt-2">
			<svg class="inline w-3 h-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
			</svg>
			Bei 5+ erkannten Karten werden Bildausschnitte zur Texterkennung an Google-Server gesendet.
			<a href="/datenschutz#m-ocr" class="underline hover:text-[var(--color-primary)]">Mehr erfahren</a>
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
					<div class="flex gap-4">
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
