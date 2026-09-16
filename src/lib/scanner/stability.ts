/**
 * Scene-stability tracking for the live scanner.
 *
 * The live preview detects card rectangles a few times per second. Before
 * auto-capturing we want every card to have settled, otherwise the captured
 * frame is motion-blurred and OCR fails. This module tracks rectangles across
 * frames and decides when the scene is steady.
 *
 * Design notes:
 * - Time-based, not frame-based. A slow phone that only manages 2-3
 *   detections per second must not wait proportionally longer than a fast
 *   laptop; both wait `minStableMs` of wall-clock time (plus a small sample
 *   minimum so a single lucky frame doesn't count as "steady").
 * - Tolerances scale with the card size in the frame. Absolute pixel
 *   thresholds tuned for a 1080p laptop webcam are far too strict for a
 *   hand-held phone filming a card that fills half the frame.
 *
 * Pure TypeScript, no DOM — unit-tested in stability.test.ts.
 */

export type TrackableRect = {
	rect: { x: number; y: number; width: number; height: number };
};

export type StabilityOptions = {
	/** Wall-clock time a rect must be tracked continuously before it counts as settled. Default 700 ms. */
	minStableMs?: number;
	/** Minimum detections a tracker needs before it counts as settled. Default 3. */
	minSamples?: number;
	/** Allowed centroid spread as a fraction of the rect's long edge. Default 0.05. */
	driftFrac?: number;
	/** Floor for the drift tolerance in pixels (tiny cards, far away). Default 10. */
	driftMinPx?: number;
	/** Max centroid distance for associating a detection with an existing tracker, as fraction of the long edge. Default 0.35. */
	matchFrac?: number;
	/** Floor for the association distance in pixels. Default 40. */
	matchMinPx?: number;
	/** Trackers not seen for this long are dropped. Default 500 ms. */
	expireMs?: number;
	/** Centroid samples kept per tracker for the drift check. Default 8. */
	maxSamples?: number;
};

type Sample = { x: number; y: number; t: number };

type Tracker = {
	id: number;
	samples: Sample[];
	/** Long edge of the most recent detection, drives the relative tolerances. */
	longEdge: number;
	/** When the current steady stretch began (reset whenever the rect moves). */
	steadySince: number;
	lastSeenAt: number;
};

const DEFAULTS: Required<StabilityOptions> = {
	minStableMs: 700,
	minSamples: 3,
	driftFrac: 0.05,
	driftMinPx: 10,
	matchFrac: 0.35,
	matchMinPx: 40,
	expireMs: 500,
	maxSamples: 8
};

function centroid(r: TrackableRect): { x: number; y: number } {
	return { x: r.rect.x + r.rect.width / 2, y: r.rect.y + r.rect.height / 2 };
}

function longEdge(r: TrackableRect): number {
	return Math.max(r.rect.width, r.rect.height);
}

/** Bounding-box extent of the samples — max spread on either axis. */
function spread(samples: Sample[]): number {
	if (samples.length < 2) return 0;
	let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
	for (const s of samples) {
		if (s.x < minX) minX = s.x;
		if (s.x > maxX) maxX = s.x;
		if (s.y < minY) minY = s.y;
		if (s.y > maxY) maxY = s.y;
	}
	return Math.max(maxX - minX, maxY - minY);
}

export class SceneStabilizer {
	private trackers: Tracker[] = [];
	private nextId = 1;
	private readonly opts: Required<StabilityOptions>;

	constructor(opts: StabilityOptions = {}) {
		this.opts = { ...DEFAULTS, ...opts };
	}

	/** Forget every tracker (camera restarted, scene cleared). */
	reset(): void {
		this.trackers = [];
	}

	/**
	 * Feed one frame's detections. `now` is a monotonic timestamp in ms
	 * (performance.now()). Call once per analysed frame, before querying.
	 */
	update(rects: TrackableRect[], now: number): void {
		const used = new Set<number>();
		for (const rect of rects) {
			const c = centroid(rect);
			const edge = longEdge(rect);
			const tracker = this.nearest(c, edge, used);
			if (tracker) {
				used.add(tracker.id);
				tracker.longEdge = edge;
				tracker.lastSeenAt = now;
				tracker.samples.push({ x: c.x, y: c.y, t: now });
				if (tracker.samples.length > this.opts.maxSamples) tracker.samples.shift();
				// The rect moved more than we tolerate: restart its steady timer
				// from this sample so it has to hold still for the full window again.
				if (spread(tracker.samples) > this.driftTolerance(tracker)) {
					tracker.samples = [{ x: c.x, y: c.y, t: now }];
					tracker.steadySince = now;
				}
			} else {
				const t: Tracker = {
					id: this.nextId++,
					samples: [{ x: c.x, y: c.y, t: now }],
					longEdge: edge,
					steadySince: now,
					lastSeenAt: now
				};
				this.trackers.push(t);
				used.add(t.id);
			}
		}
		this.trackers = this.trackers.filter((t) => now - t.lastSeenAt <= this.opts.expireMs);
	}

	/** True when this particular rect has a settled tracker. */
	isRectStable(rect: TrackableRect, now: number): boolean {
		const t = this.nearest(centroid(rect), longEdge(rect));
		return !!t && this.isSettled(t, now);
	}

	/** True when every rect has settled. An empty scene is never stable. */
	isStable(rects: TrackableRect[], now: number): boolean {
		if (rects.length === 0) return false;
		return rects.every((r) => this.isRectStable(r, now));
	}

	/**
	 * 0..1 progress of the least-settled rect, for the UI indicator.
	 * Reaches 1 exactly when `isStable` flips to true.
	 */
	progress(rects: TrackableRect[], now: number): number {
		if (rects.length === 0) return 0;
		let min = 1;
		for (const r of rects) {
			const t = this.nearest(centroid(r), longEdge(r));
			if (!t) return 0;
			const timeFrac = Math.min(1, (now - t.steadySince) / this.opts.minStableMs);
			const sampleFrac = Math.min(1, t.samples.length / this.opts.minSamples);
			min = Math.min(min, timeFrac, sampleFrac);
		}
		return min;
	}

	/** Number of live trackers — exposed for tests and debugging. */
	get trackerCount(): number {
		return this.trackers.length;
	}

	private isSettled(t: Tracker, now: number): boolean {
		return now - t.steadySince >= this.opts.minStableMs && t.samples.length >= this.opts.minSamples;
	}

	private driftTolerance(t: Tracker): number {
		return Math.max(this.opts.driftMinPx, this.opts.driftFrac * t.longEdge);
	}

	private nearest(c: { x: number; y: number }, edge: number, exclude?: Set<number>): Tracker | null {
		const maxDist = Math.max(this.opts.matchMinPx, this.opts.matchFrac * edge);
		let best: Tracker | null = null;
		let bestDist = maxDist;
		for (const t of this.trackers) {
			if (exclude?.has(t.id)) continue;
			const last = t.samples[t.samples.length - 1];
			const d = Math.hypot(c.x - last.x, c.y - last.y);
			if (d < bestDist) {
				bestDist = d;
				best = t;
			}
		}
		return best;
	}
}

/**
 * Order-independent fingerprint of a scene, built from centroids quantised to
 * a `cellPx` grid so small jitter yields the same id. Used to avoid
 * re-capturing the exact same layout twice in a row.
 */
export function sceneSignature(rects: TrackableRect[], cellPx: number): string {
	const cell = Math.max(1, cellPx);
	return rects
		.map((r) => {
			const c = centroid(r);
			return `${Math.round(c.x / cell)},${Math.round(c.y / cell)}`;
		})
		.sort()
		.join('|');
}

/**
 * Whether a tracked layout differs from a captured one by more than hand
 * jitter: a different number of rects, or a rect whose nearest counterpart
 * moved by at least `minMoveFrac` of its short edge (half a card by default).
 * The fingerprint above quantises centroids to ~30 px cells, which a hand
 * crosses constantly — used alone to re-arm the auto-capture it took the same
 * card three times in a row on a phone. Two empty frames are the same scene.
 */
export function sceneDiffers(captured: TrackableRect[], current: TrackableRect[], minMoveFrac = 0.5): boolean {
	if (captured.length !== current.length) return true;
	const used = new Set<number>();
	for (const a of captured) {
		const ca = centroid(a);
		let best = -1;
		let bestDist = Infinity;
		current.forEach((b, i) => {
			if (used.has(i)) return;
			const cb = centroid(b);
			const d = Math.hypot(cb.x - ca.x, cb.y - ca.y);
			if (d < bestDist) {
				bestDist = d;
				best = i;
			}
		});
		if (best === -1) return true;
		used.add(best);
		const shortEdge = Math.max(1, Math.min(a.rect.width, a.rect.height));
		if (bestDist >= minMoveFrac * shortEdge) return true;
	}
	return false;
}
