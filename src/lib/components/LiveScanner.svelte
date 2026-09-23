<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { version } from '$app/environment';
	import { createQuickDetector, DETECT_WORKER_URL, type QuickDetector, type QuickRect } from '$lib/scanner/detect';
	import { loadOpenCV } from '$lib/scanner/opencv';
	import { SceneStabilizer, sceneDiffers, sceneSignature } from '$lib/scanner/stability';
	import { BestFrameSelector, type FrameQuality } from '$lib/scanner/quality';
	import { fitContain, touchesFrameEdge } from '$lib/scanner/geometry';
	import { canVibrate, createScanFeedback, loadFeedbackPrefs, saveFeedbackPrefs, type FeedbackPrefs } from '$lib/scanner/feedback';

	type Props = {
		/**
		 * Called with the full-resolution captured frame. `rects` holds the
		 * rectangles the live detector was tracking as steady at capture time,
		 * in the canvas's pixel coordinates, so the caller can skip its own
		 * (much slower) detection pass. It is empty when the capture was
		 * forced while the scene was still moving — run full detection then.
		 */
		onCapture: (canvas: HTMLCanvasElement, rects: QuickRect[]) => void;
		busy?: boolean;
		log?: (msg: string) => void;
	};
	let { onCapture, busy = false, log }: Props = $props();

	let videoEl: HTMLVideoElement | null = $state(null);
	let overlayEl: HTMLCanvasElement | null = $state(null);

	let stream: MediaStream | null = null;
	let rafId = 0;
	let lastDetectAt = 0;
	let analyzeCanvas: HTMLCanvasElement | null = null;
	/** Full-resolution copy of the frame currently being analysed. */
	let scratchCanvas: HTMLCanvasElement | null = null;
	/** Full-resolution copy of the best-scoring frame of the current scene. */
	let bestCanvas: HTMLCanvasElement | null = null;
	/** Frame handed to the pipeline (copied so the loop can keep reusing its own canvases). */
	let captureCanvas: HTMLCanvasElement | null = null;
	let detector: QuickDetector | null = null;

	// 'paused': the camera is released and the viewfinder collapses, the scanned cards stay on the
	// page — for looking through the results without the camera running (and draining the phone).
	let status = $state<'idle' | 'loading' | 'requesting' | 'live' | 'paused' | 'error'>('idle');

	// Cues for scanning without looking at the screen: a tick at the capture, then "identified" or
	// "not identified". Preferences live in localStorage; vibration is offered where the browser has it.
	let feedbackPrefs = $state<FeedbackPrefs>({ sound: true, vibration: true });
	let vibrationAvailable = $state(false);
	const feedback = createScanFeedback(() => feedbackPrefs);
	function setFeedbackPref(key: keyof FeedbackPrefs, value: boolean) {
		feedbackPrefs = { ...feedbackPrefs, [key]: value };
		saveFeedbackPrefs(feedbackPrefs, typeof localStorage === 'undefined' ? null : localStorage);
		feedback.unlock();
		if (value) feedback.play('capture'); // a preview of what was just switched on
	}
	/** Called by the page when the pipeline has finished a live capture. */
	export function notifyResult(identified: boolean) {
		feedback.play(identified ? 'identified' : 'unresolved');
	}
	let errorTitle = $state('');
	let errorMsg = $state('');
	let cameras = $state<Array<{ deviceId: string; label: string }>>([]);
	let activeDeviceId = $state<string>('');
	let autoCapture = $state(true);
	let lastRectCount = $state(0);
	let stableProgress = $state(0); // 0..1
	/** Short reason why auto-capture is currently held back, shown in the badge. */
	let holdReason = $state('');
	/** Frame-quality hint ('blurry' / 'glare') for the badge. */
	let qualityHint = $state<'blurry' | 'glare' | ''>('');
	/** Where the per-frame detection runs, exposed for the harness. */
	let detectorMode = $state<'worker' | 'main' | ''>('');

	// Intrinsic stream size. The viewfinder's aspect ratio follows it, so a
	// phone held upright gets a portrait preview instead of a small
	// pillarboxed feed inside a 16:9 box that made the scanner look as if it
	// wanted the card in landscape.
	let streamW = $state(0);
	let streamH = $state(0);
	const streamAspect = $derived(streamW > 0 && streamH > 0 ? `${streamW} / ${streamH}` : '16 / 9');

	// Per-frame detected rectangles (in video pixel coords).
	let lastRects: QuickRect[] = [];
	// Which of lastRects touch the frame edge (same index order).
	let cutOff: boolean[] = [];

	// Stability tracking lives in a pure, unit-tested helper. The scene must
	// hold still for STABLE_MS (wall-clock, so slow phones don't wait longer
	// than fast laptops) before auto-capture fires.
	const stabilizer = new SceneStabilizer({ minStableMs: 700, minSamples: 3 });

	// Best-frame selection: every analysed frame of the current scene is
	// scored (sharpness over the cards, discounted by glare) and the best one
	// is kept at full resolution, so the capture doesn't use whichever frame
	// happened to be current when the stabiliser fired.
	const bestFrames = new BestFrameSelector({ windowMs: 2500, improveFactor: 1.15 });
	let bestSceneId = '';
	/** Layout the best-frame candidates belong to; compared coarsely (sceneDiffers), not by fingerprint. */
	let bestSceneRects: QuickRect[] | null = null;
	let bestRects: QuickRect[] = [];
	let bestQuality: FrameQuality | null = null;
	let bestAt = 0;

	let needSceneChange = false;
	// Telemetry for the uploaded scan log: every few seconds one line says how many frames were
	// analysed, in how many a card was found (and by which pass), how long detection took and what
	// kept auto-capture waiting. A phone session had 10-25 s waits the log could not explain.
	const STATS_EVERY_MS = 3000;
	let stats = { since: 0, frames: 0, withRects: 0, fine: 0, coarse: 0, detectMs: 0, waiting: new Map<string, number>() };
	function flushStats(now: number) {
		if (stats.frames === 0) return;
		const top = [...stats.waiting.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}x`).join(', ');
		log?.(`${((now - stats.since) / 1000).toFixed(1)} s: ${stats.frames} frames, card found in ${stats.withRects} (fine pass ${stats.fine}, coarse pass ${stats.coarse}), detect ${(stats.detectMs / stats.frames).toFixed(0)} ms avg${top ? `; waiting: ${top}` : ''}`);
		stats = { since: now, frames: 0, withRects: 0, fine: 0, coarse: 0, detectMs: 0, waiting: new Map() };
	}
	/** Layout at the last capture; auto-capture re-arms only once the layout really differs from it. */
	let capturedRects: QuickRect[] = [];

	const TARGET_FPS = 6;
	const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;
	/** Long edge of the frame handed to the quick detector. */
	const ANALYZE_EDGE = 720;
	/** Fraction of the frame's short edge a card may approach the border before it counts as cut off. */
	const EDGE_MARGIN_FRAC = 0.015;
	/** More tracked rectangles than this is not a hand-held card scene — don't auto-capture. */
	const MAX_AUTO_CAPTURE_RECTS = 12;

	async function start() {
		status = 'loading';
		errorTitle = '';
		errorMsg = '';
		try {
			// Load OpenCV before touching the camera: without it the preview
			// would run but never detect anything, which used to fail silently
			// (and re-inject the script tag on every frame). `force` bypasses the
			// post-failure cooldown because this is a user-initiated attempt.
			await loadOpenCV({ force: true });
		} catch (err) {
			status = 'error';
			errorTitle = 'Card detection unavailable';
			errorMsg = `OpenCV.js could not be loaded (${(err as Error).message}). Check your connection, then try again.`;
			log?.(`OpenCV load failed: ${err}`);
			return;
		}
		// The per-frame detector (a Web Worker with its own OpenCV copy, or the
		// main thread as fallback) starts while the camera permission is pending.
		// The worker script has a fixed URL: tie it to this build, or a cached copy outlives the deploy.
		log?.(`app version ${version}`);
		// After a pause the worker is still there: reuse it instead of loading OpenCV into a new one.
		const detectorReady = detector
			? Promise.resolve(detector)
			: createQuickDetector({ workerUrl: `${DETECT_WORKER_URL}?v=${encodeURIComponent(version)}`, log: (m) => log?.(m) });

		status = 'requesting';
		try {
			// width/height are matched against the sensor's native (landscape)
			// modes; mobile browsers rotate the frames to the device orientation
			// afterwards, so a phone held upright yields e.g. 1080x1920.
			// The resolution is asked for in both cases: with the device id alone a phone came back
			// from a pause at 480x640 instead of 1080x1080 (the browser's default mode), and the same
			// happened after switching cameras.
			const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
			const constraints: MediaStreamConstraints = activeDeviceId
				? { video: { deviceId: { exact: activeDeviceId }, ...size } }
				: { video: { facingMode: { ideal: 'environment' }, ...size } };
			stream = await navigator.mediaDevices.getUserMedia(constraints);
		} catch (err) {
			// Fallback: front-facing or any camera.
			try {
				stream = await navigator.mediaDevices.getUserMedia({ video: true });
			} catch (err2) {
				status = 'error';
				errorTitle = 'Camera unavailable';
				errorMsg = (err2 as Error).message || 'Camera permission denied.';
				log?.(`getUserMedia failed: ${errorMsg}`);
				detectorReady.then((d) => d.dispose());
				return;
			}
		}

		if (videoEl && stream) {
			videoEl.srcObject = stream;
			try {
				await videoEl.play();
			} catch { /* autoplay can be blocked; user gesture is the play button */ }
			updateStreamSize();
		}

		// Refresh device list now that we have permission.
		try {
			const devs = await navigator.mediaDevices.enumerateDevices();
			cameras = devs
				.filter((d) => d.kind === 'videoinput')
				.map((d) => ({ deviceId: d.deviceId, label: d.label || `Camera ${d.deviceId.slice(0, 4)}` }));
			const track = stream?.getVideoTracks()[0];
			const settings = track?.getSettings?.();
			if (settings?.deviceId) activeDeviceId = settings.deviceId;
		} catch { /* enumeration unavailable */ }

		const ready = await detectorReady;
		if (status !== 'requesting') {
			// stop() ran while we were waiting (component unmounted or camera switched).
			ready.dispose();
			return;
		}
		if (detector !== ready) {
			detector?.dispose();
			detector = ready;
		}
		detectorMode = detector.mode;

		status = 'live';
		analyzeCanvas = document.createElement('canvas');
		scratchCanvas = document.createElement('canvas');
		bestCanvas = document.createElement('canvas');
		captureCanvas = document.createElement('canvas');
		stabilizer.reset();
		resetBestFrame();
		scheduleFrame();
	}

	/** Release the camera and stop the frame loop; tracking state goes, the detector stays. */
	function stopStream() {
		cancelAnimationFrame(rafId);
		rafId = 0;
		if (stream) {
			for (const track of stream.getTracks()) track.stop();
			stream = null;
		}
		if (videoEl) videoEl.srcObject = null;
		stabilizer.reset();
		resetBestFrame();
		lastRects = [];
		cutOff = [];
		stableProgress = 0;
		holdReason = '';
		qualityHint = '';
		lastRectCount = 0;
	}

	function stop() {
		stopStream();
		detector?.dispose();
		detector = null;
		detectorMode = '';
		needSceneChange = false;
		streamW = 0;
		streamH = 0;
		status = 'idle';
	}

	/**
	 * Review mode: the camera is switched off (the track is stopped, so the browser's camera
	 * indicator goes out), the viewfinder collapses and the results below stay. The detection
	 * worker survives, and so does the memory of the last captured card: resuming over the same
	 * card does not capture it a second time.
	 */
	function pause() {
		if (status !== 'live') return;
		flushStats(performance.now());
		stats.since = 0;
		stopStream();
		status = 'paused';
		log?.('paused: camera released, results stay');
	}

	async function resume() {
		if (status !== 'paused') return;
		feedback.unlock();
		log?.('resumed');
		await start();
	}

	async function switchCamera(deviceId: string) {
		activeDeviceId = deviceId;
		stop();
		await start();
	}

	function resetBestFrame() {
		bestSceneRects = null;
		bestFrames.reset();
		bestSceneId = '';
		bestRects = [];
		bestQuality = null;
		bestAt = 0;
	}

	/** Track the stream's intrinsic size (also fires on device rotation). */
	function updateStreamSize() {
		if (!videoEl) return;
		const vw = videoEl.videoWidth;
		const vh = videoEl.videoHeight;
		if (vw > 0 && vh > 0 && (vw !== streamW || vh !== streamH)) {
			streamW = vw;
			streamH = vh;
			log?.(`Stream ${vw}x${vh} (${vw >= vh ? 'landscape' : 'portrait'})`);
		}
	}

	function scheduleFrame() {
		rafId = requestAnimationFrame(onFrame);
	}

	async function onFrame(ts: number) {
		if (status !== 'live' || !videoEl || !detector) {
			scheduleFrame();
			return;
		}
		// Throttle to TARGET_FPS so we don't melt phones.
		if (ts - lastDetectAt < FRAME_INTERVAL_MS) {
			drawOverlay();
			scheduleFrame();
			return;
		}
		lastDetectAt = ts;

		// Skip if a previous detect call is still running, or the parent
		// pipeline is busy with a full capture.
		if (detector.busy || busy || videoEl.readyState < 2) {
			drawOverlay();
			scheduleFrame();
			return;
		}

		const vw = videoEl.videoWidth;
		const vh = videoEl.videoHeight;
		if (vw === 0 || vh === 0 || !analyzeCanvas || !scratchCanvas) {
			scheduleFrame();
			return;
		}
		updateStreamSize();

		// Keep the full-resolution frame that is about to be analysed, so the
		// best frame of the scene can be captured pixel-for-pixel later — the
		// video has moved on by the time the asynchronous detection result
		// arrives.
		if (scratchCanvas.width !== vw || scratchCanvas.height !== vh) {
			scratchCanvas.width = vw;
			scratchCanvas.height = vh;
		}
		const sctx = scratchCanvas.getContext('2d');
		if (!sctx) {
			scheduleFrame();
			return;
		}
		sctx.drawImage(videoEl, 0, 0, vw, vh);

		// Downscale into the small analysis canvas; the detector reads its
		// pixels back once (and transfers them to the worker).
		const analyzeScale = Math.min(1, ANALYZE_EDGE / Math.max(vw, vh));
		const aw = Math.max(1, Math.round(vw * analyzeScale));
		const ah = Math.max(1, Math.round(vh * analyzeScale));
		if (analyzeCanvas.width !== aw || analyzeCanvas.height !== ah) {
			analyzeCanvas.width = aw;
			analyzeCanvas.height = ah;
		}
		const ctx = analyzeCanvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) {
			scheduleFrame();
			return;
		}
		ctx.drawImage(scratchCanvas, 0, 0, aw, ah);

		let quality: FrameQuality = { sharpness: 0, glare: 0, score: 0 };
		const detectStart = performance.now();
		try {
			const result = await detector.detect(analyzeCanvas, { coordScale: vw / aw });
			lastRects = result.rects;
			quality = result.quality;
		} catch (err) {
			log?.(`live detect error: ${err}`);
			lastRects = [];
		}
		if (status !== 'live') return; // stopped while the frame was analysed
		if (stats.frames === 0 && stats.since === 0) stats.since = ts;
		stats.frames++;
		stats.detectMs += performance.now() - detectStart;
		if (lastRects.length > 0) {
			stats.withRects++;
			if (lastRects.some((r) => r.source === 'coarse')) stats.coarse++;
			else stats.fine++;
		}

		const now = ts;
		stabilizer.update(lastRects, now);
		const edgeMargin = Math.max(4, EDGE_MARGIN_FRAC * Math.min(vw, vh));
		cutOff = lastRects.map((r) => touchesFrameEdge(r.rect, vw, vh, edgeMargin));
		lastRectCount = lastRects.length;
		drawOverlay();

		const stable = stabilizer.isStable(lastRects, now);
		stableProgress = stabilizer.progress(lastRects, now);
		const sceneId = lastRects.length ? sceneSignature(lastRects, sceneCellPx(vw, vh)) : '';

		// Best-frame bookkeeping. The selector only compares frames of the same
		// scene, so a sharp frame from before the cards were put down never
		// stands in for the scene that is captured.
		if (!sceneId) {
			resetBestFrame();
			qualityHint = '';
		} else {
			// The same scene up to hand jitter: the fingerprint quantises centroids
			// to ~30 px cells, which a hand crosses constantly, so the layouts are
			// compared coarsely instead — otherwise every jitter threw the best
			// frame away and the capture came from whatever frame followed.
			if (!bestSceneRects || sceneDiffers(bestSceneRects, lastRects)) {
				// Forget the previous scene's frame entirely: it must not stand in for this
				// one while no frame of this scene has qualified yet (see the cut-off rule below).
				resetBestFrame();
				bestSceneId = sceneId;
				bestSceneRects = lastRects;
			}
			qualityHint = bestFrames.hint(quality, now);
			// A frame whose card touches the edge never becomes the best frame: the capture
			// hands the best frame's rectangles to the pipeline, and a sharper frame from
			// while the card was still being put down delivered a cut-off quad (phone,
			// 2026-09-18: "card cut off at the edge" 6x, then a capture of a quad at y=0).
			if (!cutOff.some(Boolean) && lastRects.length <= MAX_AUTO_CAPTURE_RECTS && bestFrames.offer(quality, now) && bestCanvas) {
				// Promote the analysed frame: swap the canvases instead of copying pixels.
				[bestCanvas, scratchCanvas] = [scratchCanvas, bestCanvas];
				bestRects = lastRects;
				bestQuality = quality;
				bestAt = now;
			}
		}

		const anyCutOff = cutOff.some(Boolean);
		if (lastRects.length > MAX_AUTO_CAPTURE_RECTS) {
			holdReason = 'too many rectangles';
		} else if (anyCutOff) {
			holdReason = 'card cut off at the edge';
		} else {
			holdReason = '';
		}

		// Re-arm only when the layout really changed since the capture: the
		// cards left the frame (picked up and put back), a card moved by half
		// its short edge, or the count changed. Re-arming on the fingerprint
		// alone captured the same card three times in a row on a phone — hand
		// jitter crosses a fingerprint cell all the time.
		if (needSceneChange && (lastRects.length === 0 || sceneDiffers(capturedRects, lastRects))) {
			needSceneChange = false;
		}
		const capturing = stable && !needSceneChange && autoCapture && !busy && !holdReason;
		if (!capturing) {
			const why = busy
				? 'processing the previous capture'
				: lastRects.length === 0
					? 'no card found'
					: holdReason
						? holdReason
						: needSceneChange
							? 'same card as the last capture'
							: !autoCapture
								? 'auto-capture off'
								: 'not steady yet';
			stats.waiting.set(why, (stats.waiting.get(why) ?? 0) + 1);
		}
		if (now - stats.since >= STATS_EVERY_MS) flushStats(now);
		if (capturing) {
			flushStats(now);
			triggerCapture(sceneId, lastRects, now);
		}

		scheduleFrame();
	}

	/** Quantisation cell for the scene fingerprint: ~1/64 of the long edge (30 px at 1080p). */
	function sceneCellPx(vw: number, vh: number): number {
		return Math.max(16, Math.round(Math.max(vw, vh) / 64));
	}

	function captureNow() {
		feedback.unlock();
		const vw = videoEl?.videoWidth ?? 0;
		const vh = videoEl?.videoHeight ?? 0;
		const now = performance.now();
		// Only hand over the tracked rectangles when they are known to be
		// steady; a forced capture mid-motion should run full detection.
		const stable = stabilizer.isStable(lastRects, now);
		const sceneId = sceneSignature(lastRects, sceneCellPx(vw, vh));
		triggerCapture(sceneId || `manual-${Date.now()}`, stable ? lastRects : [], now);
	}

	/**
	 * Hand a frame to the pipeline: the best-scoring frame of the current
	 * scene when one exists (same rectangles, chosen for sharpness and lack
	 * of glare), otherwise the live frame as it is right now.
	 */
	function triggerCapture(sceneId: string, rects: QuickRect[], now: number) {
		if (!videoEl || !captureCanvas) return;
		const vw = videoEl.videoWidth;
		const vh = videoEl.videoHeight;
		if (vw === 0 || vh === 0) return;
		captureCanvas.width = vw;
		captureCanvas.height = vh;
		const ctx = captureCanvas.getContext('2d');
		if (!ctx) return;
		const best = bestCanvas && bestQuality && bestSceneRects !== null && !sceneDiffers(bestSceneRects, rects) && rects.length > 0
			&& bestCanvas.width === vw && bestCanvas.height === vh
			? { canvas: bestCanvas, quality: bestQuality }
			: null;
		let handedRects = rects;
		if (best) {
			ctx.drawImage(best.canvas, 0, 0);
			handedRects = bestRects;
			log?.(`Best frame of the scene: sharpness ${best.quality.sharpness.toFixed(0)}, glare ${(best.quality.glare * 100).toFixed(1)}%, ${Math.round(now - bestAt)} ms old`);
		} else {
			ctx.drawImage(videoEl, 0, 0, vw, vh);
		}
		needSceneChange = true;
		capturedRects = lastRects;
		feedback.play('capture');
		log?.(`Live capture ${vw}x${vh} (${lastRects.length} card${lastRects.length === 1 ? '' : 's'} detected, ${handedRects.length} handed to the pipeline, scene=${sceneId})`);
		onCapture(captureCanvas, [...handedRects]);
	}

	function drawOverlay() {
		if (!overlayEl || !videoEl) return;
		const vw = videoEl.videoWidth;
		const vh = videoEl.videoHeight;
		if (vw === 0 || vh === 0) return;
		const dispW = videoEl.clientWidth;
		const dispH = videoEl.clientHeight;
		if (dispW === 0 || dispH === 0) return;
		// Render at device resolution so the outlines stay crisp on phones.
		const dpr = window.devicePixelRatio || 1;
		const pxW = Math.round(dispW * dpr);
		const pxH = Math.round(dispH * dpr);
		if (overlayEl.width !== pxW || overlayEl.height !== pxH) {
			overlayEl.width = pxW;
			overlayEl.height = pxH;
		}
		const ctx = overlayEl.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, dispW, dispH);

		// The <video> uses object-fit: contain, so the stream is letterboxed
		// inside the element box whenever the aspect ratios differ. Map through
		// the same fit (uniform scale + offset) — scaling x and y independently
		// squashed a portrait card into a landscape outline.
		const fit = fitContain(vw, vh, dispW, dispH);
		const now = performance.now();
		ctx.lineWidth = 3;
		for (let i = 0; i < lastRects.length; i++) {
			const rect = lastRects[i];
			const isStable = stabilizer.isRectStable(rect, now);
			ctx.strokeStyle = cutOff[i] ? '#ef4444' : isStable ? '#22c55e' : '#facc15';
			ctx.beginPath();
			for (let k = 0; k < 4; k++) {
				const [x, y] = rect.corners[k];
				const px = fit.x + x * fit.scale;
				const py = fit.y + y * fit.scale;
				if (k === 0) ctx.moveTo(px, py);
				else ctx.lineTo(px, py);
			}
			ctx.closePath();
			ctx.stroke();
		}
	}

	onMount(() => {
		feedbackPrefs = loadFeedbackPrefs(typeof localStorage === 'undefined' ? null : localStorage);
		vibrationAvailable = canVibrate();
		// The tap on "Live camera" that mounted this component counts as the user gesture on most
		// browsers; any later tap inside the component unlocks the audio on the stricter ones.
		feedback.unlock();
		start();
	});

	onDestroy(() => {
		stop();
		feedback.dispose();
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="space-y-3" data-detector={detectorMode} data-status={status} onpointerdown={() => feedback.unlock()}>
	{#if status === 'paused'}
		<div class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
			<div>
				<p class="text-sm font-medium">Camera paused</p>
				<p class="text-xs text-[var(--color-text-muted)]">The camera is off. Your scanned cards stay below.</p>
			</div>
			<button
				type="button"
				onclick={resume}
				class="ml-auto bg-[var(--color-primary-button)] hover:bg-[var(--color-primary-button-hover)] px-4 py-2 rounded-lg text-sm transition-colors"
			>
				Resume camera
			</button>
		</div>
	{/if}
	<!-- The box takes the stream's aspect ratio (portrait on an upright phone),
	     capped in height so the controls stay reachable; any remaining
	     letterbox is accounted for by the overlay's fitContain mapping. -->
	<div
		class="relative w-full max-h-[70vh] bg-black rounded-lg overflow-hidden border border-[var(--color-border)]"
		class:hidden={status === 'paused'}
		style="aspect-ratio: {streamAspect};"
	>
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			bind:this={videoEl}
			autoplay
			playsinline
			muted
			onloadedmetadata={updateStreamSize}
			onresize={updateStreamSize}
			class="block w-full h-full object-contain"
		></video>
		<canvas bind:this={overlayEl} class="absolute inset-0 w-full h-full pointer-events-none"></canvas>
		{#if status === 'loading' || status === 'requesting'}
			<div class="absolute inset-0 flex items-center justify-center text-white text-sm bg-black/60">
				{status === 'loading' ? 'Loading card detection...' : 'Requesting camera...'}
			</div>
		{:else if status === 'error'}
			<div class="absolute inset-0 flex flex-col items-center justify-center text-white text-sm bg-black/70 p-4 text-center">
				<p class="font-medium mb-2">{errorTitle}</p>
				<p class="text-xs text-white/70 mb-3">{errorMsg}</p>
				<button onclick={start} class="bg-[var(--color-primary-button)] hover:bg-[var(--color-primary-button-hover)] px-3 py-1 rounded text-xs">
					Try again
				</button>
			</div>
		{/if}
		{#if status === 'live' && lastRectCount > 0}
			<div class="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/60 text-white text-xs" data-quality-hint={qualityHint}>
				{lastRectCount} card{lastRectCount === 1 ? '' : 's'} · steady {Math.round(stableProgress * 100)}%
				{#if holdReason}
					<span class="text-red-300"> · {holdReason}</span>
				{/if}
				{#if qualityHint === 'blurry'}
					<span class="text-yellow-300"> · blurry, hold still</span>
				{:else if qualityHint === 'glare'}
					<span class="text-yellow-300"> · glare on the card, tilt it a little</span>
				{/if}
			</div>
		{/if}
	</div>

	<div class="flex flex-wrap items-center gap-x-3 gap-y-2" class:hidden={status === 'paused'}>
		<button
			type="button"
			onclick={captureNow}
			disabled={status !== 'live' || busy}
			class="bg-[var(--color-primary-button)] hover:bg-[var(--color-primary-button-hover)] disabled:opacity-50 px-4 py-2 rounded-lg text-sm transition-colors"
		>
			{busy ? 'Identifying...' : 'Capture now'}
		</button>

		<button
			type="button"
			onclick={pause}
			disabled={status !== 'live'}
			title="Switch the camera off and look through the scanned cards"
			class="border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-primary)] disabled:opacity-50 px-4 py-2 rounded-lg text-sm transition-colors"
		>
			Pause camera
		</button>

		<label class="flex items-center gap-2 cursor-pointer select-none text-sm">
			<input type="checkbox" bind:checked={autoCapture} class="w-4 h-4 rounded border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-primary)] focus:ring-[var(--color-primary)]" />
			<span class="text-[var(--color-text-muted)]">Auto-capture when steady</span>
		</label>

		<label class="flex items-center gap-2 cursor-pointer select-none text-sm">
			<input type="checkbox" checked={feedbackPrefs.sound} onchange={(e) => setFeedbackPref('sound', (e.target as HTMLInputElement).checked)} class="w-4 h-4 rounded border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-primary)] focus:ring-[var(--color-primary)]" />
			<span class="text-[var(--color-text-muted)]">Sound</span>
		</label>
		{#if vibrationAvailable}
			<label class="flex items-center gap-2 cursor-pointer select-none text-sm">
				<input type="checkbox" checked={feedbackPrefs.vibration} onchange={(e) => setFeedbackPref('vibration', (e.target as HTMLInputElement).checked)} class="w-4 h-4 rounded border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-primary)] focus:ring-[var(--color-primary)]" />
				<span class="text-[var(--color-text-muted)]">Vibration</span>
			</label>
		{:else if status === 'live'}
			<!-- Firefox removed navigator.vibrate (disabled on Android since 79, gone in 129); iOS Safari never had it. -->
			<span class="text-xs text-[var(--color-text-muted)]" title="Firefox and iOS Safari do not let web pages vibrate; Chrome on Android does.">No vibration in this browser</span>
		{/if}

		{#if cameras.length > 1}
			<select
				aria-label="Camera"
				value={activeDeviceId}
				onchange={(e) => switchCamera((e.target as HTMLSelectElement).value)}
				class="ml-auto bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-2 py-1 text-xs"
			>
				{#each cameras as cam (cam.deviceId)}
					<option value={cam.deviceId}>{cam.label}</option>
				{/each}
			</select>
		{/if}
	</div>

	<p class="text-xs text-[var(--color-text-muted)]" class:hidden={status === 'paused'}>
		Hold one or more cards upright in front of the camera, fully inside the frame. Yellow outlines mean detected, green means steady, red means the card is cut off at the edge (move back a little). With auto-capture enabled, identification fires as soon as the scene holds still and uses the sharpest recent frame; the badge warns about blur and glare. Move the cards out of frame and back in to capture again.
	</p>
</div>
