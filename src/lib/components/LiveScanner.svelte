<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { detectCardsQuick, isQuickBusy, type QuickRect } from '$lib/scanner/detect';
	import { loadOpenCV } from '$lib/scanner/opencv';
	import { SceneStabilizer, sceneSignature } from '$lib/scanner/stability';
	import { fitContain, touchesFrameEdge } from '$lib/scanner/geometry';

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
	let captureCanvas: HTMLCanvasElement | null = null;

	let status = $state<'idle' | 'loading' | 'requesting' | 'live' | 'error'>('idle');
	let errorTitle = $state('');
	let errorMsg = $state('');
	let cameras = $state<Array<{ deviceId: string; label: string }>>([]);
	let activeDeviceId = $state<string>('');
	let autoCapture = $state(true);
	let lastRectCount = $state(0);
	let stableProgress = $state(0); // 0..1
	/** Short reason why auto-capture is currently held back, shown in the badge. */
	let holdReason = $state('');

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

	let lastCapturedSceneId = '';
	let needSceneChange = false;

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

		status = 'requesting';
		try {
			// width/height are matched against the sensor's native (landscape)
			// modes; mobile browsers rotate the frames to the device orientation
			// afterwards, so a phone held upright yields e.g. 1080x1920.
			const constraints: MediaStreamConstraints = activeDeviceId
				? { video: { deviceId: { exact: activeDeviceId } } }
				: { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } };
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

		status = 'live';
		analyzeCanvas = document.createElement('canvas');
		captureCanvas = document.createElement('canvas');
		stabilizer.reset();
		scheduleFrame();
	}

	function stop() {
		cancelAnimationFrame(rafId);
		rafId = 0;
		if (stream) {
			for (const track of stream.getTracks()) track.stop();
			stream = null;
		}
		if (videoEl) videoEl.srcObject = null;
		stabilizer.reset();
		lastRects = [];
		cutOff = [];
		lastCapturedSceneId = '';
		needSceneChange = false;
		stableProgress = 0;
		holdReason = '';
		lastRectCount = 0;
		streamW = 0;
		streamH = 0;
		status = 'idle';
	}

	async function switchCamera(deviceId: string) {
		activeDeviceId = deviceId;
		stop();
		await start();
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
		if (status !== 'live' || !videoEl) {
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
		if (isQuickBusy() || busy || videoEl.readyState < 2) {
			drawOverlay();
			scheduleFrame();
			return;
		}

		const vw = videoEl.videoWidth;
		const vh = videoEl.videoHeight;
		if (vw === 0 || vh === 0 || !analyzeCanvas) {
			scheduleFrame();
			return;
		}
		updateStreamSize();

		// Draw the frame straight into the small analysis canvas. The detector
		// used to receive the full-resolution frame and downscale it itself,
		// which cost an extra full-size blit plus a canvas allocation per frame.
		const analyzeScale = Math.min(1, ANALYZE_EDGE / Math.max(vw, vh));
		const aw = Math.max(1, Math.round(vw * analyzeScale));
		const ah = Math.max(1, Math.round(vh * analyzeScale));
		if (analyzeCanvas.width !== aw || analyzeCanvas.height !== ah) {
			analyzeCanvas.width = aw;
			analyzeCanvas.height = ah;
		}
		const ctx = analyzeCanvas.getContext('2d');
		if (!ctx) {
			scheduleFrame();
			return;
		}
		ctx.drawImage(videoEl, 0, 0, aw, ah);

		try {
			lastRects = await detectCardsQuick(analyzeCanvas, { maxEdge: ANALYZE_EDGE, coordScale: vw / aw });
		} catch (err) {
			log?.(`live detect error: ${err}`);
			lastRects = [];
		}

		const now = ts;
		stabilizer.update(lastRects, now);
		const edgeMargin = Math.max(4, EDGE_MARGIN_FRAC * Math.min(vw, vh));
		cutOff = lastRects.map((r) => touchesFrameEdge(r.rect, vw, vh, edgeMargin));
		lastRectCount = lastRects.length;
		drawOverlay();

		const stable = stabilizer.isStable(lastRects, now);
		stableProgress = stabilizer.progress(lastRects, now);

		const anyCutOff = cutOff.some(Boolean);
		if (lastRects.length > MAX_AUTO_CAPTURE_RECTS) {
			holdReason = 'too many rectangles';
		} else if (anyCutOff) {
			holdReason = 'card cut off at the edge';
		} else {
			holdReason = '';
		}

		if (stable) {
			const sceneId = sceneSignature(lastRects, sceneCellPx(vw, vh));
			if (sceneId !== lastCapturedSceneId && !needSceneChange) {
				if (autoCapture && !busy && !holdReason) {
					triggerCapture(sceneId, lastRects);
				}
			} else if (sceneId !== lastCapturedSceneId) {
				// Scene already changed enough that we can re-arm.
				needSceneChange = false;
			}
		} else {
			// Scene moving — once it stabilizes again, allow re-capture
			// even if the resulting sceneId matches the previous one
			// (user picked the cards up and put them back).
			if (lastRects.length === 0) needSceneChange = false;
		}

		scheduleFrame();
	}

	/** Quantisation cell for the scene fingerprint: ~1/64 of the long edge (30 px at 1080p). */
	function sceneCellPx(vw: number, vh: number): number {
		return Math.max(16, Math.round(Math.max(vw, vh) / 64));
	}

	function captureNow() {
		const vw = videoEl?.videoWidth ?? 0;
		const vh = videoEl?.videoHeight ?? 0;
		const now = performance.now();
		// Only hand over the tracked rectangles when they are known to be
		// steady; a forced capture mid-motion should run full detection.
		const stable = stabilizer.isStable(lastRects, now);
		const sceneId = sceneSignature(lastRects, sceneCellPx(vw, vh));
		triggerCapture(sceneId || `manual-${Date.now()}`, stable ? lastRects : []);
	}

	function triggerCapture(sceneId: string, rects: QuickRect[]) {
		if (!videoEl || !captureCanvas) return;
		const vw = videoEl.videoWidth;
		const vh = videoEl.videoHeight;
		if (vw === 0 || vh === 0) return;
		captureCanvas.width = vw;
		captureCanvas.height = vh;
		const ctx = captureCanvas.getContext('2d');
		if (!ctx) return;
		ctx.drawImage(videoEl, 0, 0, vw, vh);
		lastCapturedSceneId = sceneId;
		needSceneChange = true;
		log?.(`Live capture ${vw}x${vh} (${lastRects.length} card${lastRects.length === 1 ? '' : 's'} detected, ${rects.length} handed to the pipeline, scene=${sceneId})`);
		onCapture(captureCanvas, [...rects]);
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
		start();
	});

	onDestroy(() => {
		stop();
	});
</script>

<div class="space-y-3">
	<!-- The box takes the stream's aspect ratio (portrait on an upright phone),
	     capped in height so the controls stay reachable; any remaining
	     letterbox is accounted for by the overlay's fitContain mapping. -->
	<div
		class="relative w-full max-h-[70vh] bg-black rounded-lg overflow-hidden border border-[var(--color-border)]"
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
			<div class="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/60 text-white text-xs">
				{lastRectCount} card{lastRectCount === 1 ? '' : 's'} · steady {Math.round(stableProgress * 100)}%
				{#if holdReason}
					<span class="text-red-300"> · {holdReason}</span>
				{/if}
			</div>
		{/if}
	</div>

	<div class="flex flex-wrap items-center gap-2">
		<button
			type="button"
			onclick={captureNow}
			disabled={status !== 'live' || busy}
			class="bg-[var(--color-primary-button)] hover:bg-[var(--color-primary-button-hover)] disabled:opacity-50 px-4 py-2 rounded-lg text-sm transition-colors"
		>
			{busy ? 'Identifying...' : 'Capture now'}
		</button>

		<label class="flex items-center gap-2 cursor-pointer select-none text-sm">
			<input type="checkbox" bind:checked={autoCapture} class="w-4 h-4 rounded border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-primary)] focus:ring-[var(--color-primary)]" />
			<span class="text-[var(--color-text-muted)]">Auto-capture when steady</span>
		</label>

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

	<p class="text-xs text-[var(--color-text-muted)]">
		Hold one or more cards upright in front of the camera, fully inside the frame. Yellow outlines mean detected, green means steady, red means the card is cut off at the edge (move back a little). With auto-capture enabled, identification fires as soon as the scene holds still. Move the cards out of frame and back in to capture again.
	</p>
</div>
