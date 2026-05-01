<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { detectCardsQuick, isQuickBusy, type QuickRect } from '$lib/scanner/detect';
	import { loadOpenCV } from '$lib/scanner/opencv';

	type Props = {
		onCapture: (canvas: HTMLCanvasElement) => void;
		busy?: boolean;
		log?: (msg: string) => void;
	};
	let { onCapture, busy = false, log }: Props = $props();

	let videoEl: HTMLVideoElement | null = $state(null);
	let overlayEl: HTMLCanvasElement | null = $state(null);
	let containerEl: HTMLDivElement | null = $state(null);

	let stream: MediaStream | null = null;
	let rafId = 0;
	let lastDetectAt = 0;
	let analyzeCanvas: HTMLCanvasElement | null = null;
	let captureCanvas: HTMLCanvasElement | null = null;

	let status = $state<'idle' | 'requesting' | 'live' | 'error'>('idle');
	let errorMsg = $state('');
	let cameras = $state<Array<{ deviceId: string; label: string }>>([]);
	let activeDeviceId = $state<string>('');
	let autoCapture = $state(true);
	let lastRectCount = $state(0);
	let stableProgress = $state(0); // 0..1

	// Per-frame detected rectangles (in video pixel coords).
	let lastRects: QuickRect[] = [];

	// Stability tracking. Each tracker holds the last few centroids it saw;
	// when all of them sit within `STABLE_DRIFT_PX` over `STABLE_FRAMES`,
	// we consider the rect "settled". The whole scene must be stable
	// before auto-capture fires.
	type Tracker = { id: number; centroids: Array<{ x: number; y: number }>; lastSeenAt: number };
	let trackers: Tracker[] = [];
	let nextTrackerId = 1;
	const STABLE_FRAMES = 8;
	const STABLE_DRIFT_PX = 14;
	const TRACKER_MAX_DIST = 60;

	let lastCapturedSceneId = '';
	let needSceneChange = false;

	const TARGET_FPS = 6;
	const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;

	async function start() {
		status = 'requesting';
		errorMsg = '';
		try {
			// Pre-warm OpenCV so the first detect() doesn't stall the rAF loop.
			await loadOpenCV();
		} catch (err) {
			log?.(`OpenCV preload failed: ${err}`);
		}

		try {
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
		trackers = [];
		lastRects = [];
		lastCapturedSceneId = '';
		needSceneChange = false;
		stableProgress = 0;
		status = 'idle';
	}

	async function switchCamera(deviceId: string) {
		activeDeviceId = deviceId;
		stop();
		await start();
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
		if (analyzeCanvas.width !== vw || analyzeCanvas.height !== vh) {
			analyzeCanvas.width = vw;
			analyzeCanvas.height = vh;
		}
		const ctx = analyzeCanvas.getContext('2d');
		if (!ctx) {
			scheduleFrame();
			return;
		}
		ctx.drawImage(videoEl, 0, 0, vw, vh);

		try {
			lastRects = await detectCardsQuick(analyzeCanvas);
		} catch (err) {
			log?.(`live detect error: ${err}`);
			lastRects = [];
		}

		updateTrackers(lastRects);
		lastRectCount = lastRects.length;
		drawOverlay();

		const stable = sceneIsStable();
		stableProgress = stableScore();
		if (stable) {
			const sceneId = computeSceneId(lastRects);
			if (sceneId !== lastCapturedSceneId && !needSceneChange) {
				if (autoCapture && !busy) {
					triggerCapture(sceneId);
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

	function captureNow() {
		const sceneId = computeSceneId(lastRects);
		triggerCapture(sceneId || `manual-${Date.now()}`);
	}

	function triggerCapture(sceneId: string) {
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
		log?.(`Live capture (${lastRects.length} card${lastRects.length === 1 ? '' : 's'} detected, scene=${sceneId})`);
		onCapture(captureCanvas);
	}

	function drawOverlay() {
		if (!overlayEl || !videoEl || !containerEl) return;
		const vw = videoEl.videoWidth;
		const vh = videoEl.videoHeight;
		if (vw === 0 || vh === 0) return;
		const dispW = videoEl.clientWidth;
		const dispH = videoEl.clientHeight;
		if (overlayEl.width !== dispW || overlayEl.height !== dispH) {
			overlayEl.width = dispW;
			overlayEl.height = dispH;
		}
		const ctx = overlayEl.getContext('2d');
		if (!ctx) return;
		ctx.clearRect(0, 0, dispW, dispH);
		const sx = dispW / vw;
		const sy = dispH / vh;
		ctx.lineWidth = 3;
		for (const rect of lastRects) {
			const tracker = findTrackerFor(rect);
			const isStable = tracker && tracker.centroids.length >= STABLE_FRAMES && trackerDrift(tracker) < STABLE_DRIFT_PX;
			ctx.strokeStyle = isStable ? '#22c55e' : '#facc15';
			ctx.beginPath();
			for (let i = 0; i < 4; i++) {
				const [x, y] = rect.corners[i];
				const px = x * sx;
				const py = y * sy;
				if (i === 0) ctx.moveTo(px, py);
				else ctx.lineTo(px, py);
			}
			ctx.closePath();
			ctx.stroke();
		}
	}

	function rectCentroid(r: QuickRect): { x: number; y: number } {
		return { x: r.rect.x + r.rect.width / 2, y: r.rect.y + r.rect.height / 2 };
	}

	function updateTrackers(rects: QuickRect[]) {
		const now = performance.now();
		const used = new Set<number>();
		for (const rect of rects) {
			const c = rectCentroid(rect);
			let best: Tracker | null = null;
			let bestDist = TRACKER_MAX_DIST;
			for (const t of trackers) {
				if (used.has(t.id)) continue;
				const last = t.centroids[t.centroids.length - 1];
				const d = Math.hypot(c.x - last.x, c.y - last.y);
				if (d < bestDist) {
					bestDist = d;
					best = t;
				}
			}
			if (best) {
				best.centroids.push(c);
				if (best.centroids.length > STABLE_FRAMES) best.centroids.shift();
				best.lastSeenAt = now;
				used.add(best.id);
			} else {
				trackers.push({ id: nextTrackerId++, centroids: [c], lastSeenAt: now });
			}
		}
		// Drop trackers we haven't seen for >500 ms.
		trackers = trackers.filter((t) => now - t.lastSeenAt < 500);
	}

	function findTrackerFor(rect: QuickRect): Tracker | null {
		const c = rectCentroid(rect);
		let best: Tracker | null = null;
		let bestDist = TRACKER_MAX_DIST;
		for (const t of trackers) {
			const last = t.centroids[t.centroids.length - 1];
			const d = Math.hypot(c.x - last.x, c.y - last.y);
			if (d < bestDist) {
				bestDist = d;
				best = t;
			}
		}
		return best;
	}

	function trackerDrift(t: Tracker): number {
		if (t.centroids.length < 2) return Infinity;
		let maxDx = 0;
		let maxDy = 0;
		const first = t.centroids[0];
		for (const c of t.centroids) {
			maxDx = Math.max(maxDx, Math.abs(c.x - first.x));
			maxDy = Math.max(maxDy, Math.abs(c.y - first.y));
		}
		return Math.max(maxDx, maxDy);
	}

	function sceneIsStable(): boolean {
		if (lastRects.length === 0) return false;
		for (const rect of lastRects) {
			const t = findTrackerFor(rect);
			if (!t || t.centroids.length < STABLE_FRAMES) return false;
			if (trackerDrift(t) >= STABLE_DRIFT_PX) return false;
		}
		return true;
	}

	function stableScore(): number {
		if (lastRects.length === 0) return 0;
		let minFrac = 1;
		for (const rect of lastRects) {
			const t = findTrackerFor(rect);
			if (!t) return 0;
			const frac = Math.min(1, t.centroids.length / STABLE_FRAMES);
			if (frac < minFrac) minFrac = frac;
		}
		return minFrac;
	}

	function computeSceneId(rects: QuickRect[]): string {
		// Quantize centroids to a 30-px grid so tiny jitter doesn't change the id.
		const parts = rects
			.map((r) => {
				const c = rectCentroid(r);
				return `${Math.round(c.x / 30)},${Math.round(c.y / 30)}`;
			})
			.sort();
		return parts.join('|');
	}

	onMount(() => {
		start();
	});

	onDestroy(() => {
		stop();
	});
</script>

<div class="space-y-3">
	<div bind:this={containerEl} class="relative bg-black rounded-lg overflow-hidden border border-[var(--color-border)]">
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			bind:this={videoEl}
			autoplay
			playsinline
			muted
			class="w-full block aspect-video object-contain"
		></video>
		<canvas bind:this={overlayEl} class="absolute inset-0 w-full h-full pointer-events-none"></canvas>
		{#if status === 'requesting'}
			<div class="absolute inset-0 flex items-center justify-center text-white text-sm bg-black/60">
				Requesting camera...
			</div>
		{:else if status === 'error'}
			<div class="absolute inset-0 flex flex-col items-center justify-center text-white text-sm bg-black/70 p-4 text-center">
				<p class="font-medium mb-2">Camera unavailable</p>
				<p class="text-xs text-white/70 mb-3">{errorMsg}</p>
				<button onclick={start} class="bg-[var(--color-primary-button)] hover:bg-[var(--color-primary-button-hover)] px-3 py-1 rounded text-xs">
					Try again
				</button>
			</div>
		{/if}
		{#if status === 'live' && lastRectCount > 0}
			<div class="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/60 text-white text-xs">
				{lastRectCount} card{lastRectCount === 1 ? '' : 's'} · stability {Math.round(stableProgress * 100)}%
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
		Hold one or more cards in front of the camera. Yellow outlines mean detected; green means stable. With auto-capture enabled, identification fires automatically once the scene settles. Move the cards out of frame and back in to capture again.
	</p>
</div>
