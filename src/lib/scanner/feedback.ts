/**
 * Audible and haptic cues for the live scanner, so a card can be scanned
 * without looking at the screen: a short tick when a frame is captured (the
 * card may be taken away), then a rising two-tone when the card was
 * identified or a low tone when it was not (scan it again).
 *
 * Sound is WebAudio (no asset to load, works offline); vibration is
 * `navigator.vibrate`, which iOS Safari does not have — there the sound is the
 * only cue. Both need a user gesture first on most browsers, hence `unlock()`.
 * Everything is best effort: a missing API or a blocked AudioContext must
 * never break a scan.
 */

export type FeedbackCue = 'capture' | 'identified' | 'unresolved';

export type CuePattern = {
	/** `navigator.vibrate` pattern in ms (vibrate, pause, vibrate, ...). */
	vibrate: number[];
	/** Tones played one after the other. */
	tones: Array<{ hz: number; ms: number }>;
};

export const FEEDBACK_CUES: Record<FeedbackCue, CuePattern> = {
	capture: { vibrate: [35], tones: [{ hz: 880, ms: 70 }] },
	identified: { vibrate: [25, 50, 25], tones: [{ hz: 660, ms: 80 }, { hz: 990, ms: 110 }] },
	unresolved: { vibrate: [120], tones: [{ hz: 330, ms: 180 }] }
};

export type FeedbackPrefs = { sound: boolean; vibration: boolean };
export const DEFAULT_FEEDBACK_PREFS: FeedbackPrefs = { sound: true, vibration: true };
const PREFS_KEY = 'mtg.scan.feedback';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** Stored preferences, defaults for anything missing or unreadable. */
export function loadFeedbackPrefs(storage?: StorageLike | null): FeedbackPrefs {
	try {
		const raw = storage?.getItem(PREFS_KEY);
		if (!raw) return { ...DEFAULT_FEEDBACK_PREFS };
		const parsed = JSON.parse(raw) as Partial<FeedbackPrefs> | null;
		return {
			sound: typeof parsed?.sound === 'boolean' ? parsed.sound : DEFAULT_FEEDBACK_PREFS.sound,
			vibration: typeof parsed?.vibration === 'boolean' ? parsed.vibration : DEFAULT_FEEDBACK_PREFS.vibration
		};
	} catch {
		return { ...DEFAULT_FEEDBACK_PREFS };
	}
}

export function saveFeedbackPrefs(prefs: FeedbackPrefs, storage?: StorageLike | null): void {
	try {
		storage?.setItem(PREFS_KEY, JSON.stringify({ sound: !!prefs.sound, vibration: !!prefs.vibration }));
	} catch {
		/* private mode / quota: the preference just does not stick */
	}
}

/** Whether this browser can vibrate at all (no toggle is offered otherwise). */
export function canVibrate(): boolean {
	return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

export type ScanFeedback = {
	/** Create / resume the audio context; call from a user gesture (tap, click). */
	unlock(): void;
	play(cue: FeedbackCue): Promise<void>;
	dispose(): void;
};

export type AudioState = AudioContextState | 'unavailable';

export function createScanFeedback(getPrefs: () => FeedbackPrefs, options: {
	log?: (message: string) => void;
	onState?: (state: AudioState) => void;
} = {}): ScanFeedback {
	let ctx: AudioContext | null = null;
	let cueId = 0;
	let disposed = false;
	const log = (message: string) => { try { options.log?.(message); } catch { /* diagnostics must not interrupt scanning */ } };
	const reportState = () => { try { options.onState?.(ctx?.state ?? 'unavailable'); } catch { /* best effort */ } };
	const audio = (): AudioContext | null => {
		if (disposed) return null;
		if (ctx && ctx.state !== 'closed') return ctx;
		if (typeof window === 'undefined') return null;
		const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!AC) return null;
		try {
			if (ctx) ctx.onstatechange = null;
			ctx = new AC();
			ctx.onstatechange = () => {
				log(`audio state: ${ctx?.state ?? 'unavailable'}`);
				reportState();
			};
		} catch {
			ctx = null;
		}
		reportState();
		return ctx;
	};
	const resume = (c: AudioContext): Promise<void> => {
		if (c.state === 'running') return Promise.resolve();
		try {
			// Retry during each user gesture even if an earlier resume is still
			// pending: that earlier call may not have had playback permission.
			return c.resume().catch(() => {
				log('audio resume rejected');
			}).finally(reportState);
		} catch {
			log('audio resume failed');
			return Promise.resolve();
		}
	};
	return {
		unlock() {
			const c = audio();
			if (c) void resume(c);
			reportState();
		},
		async play(cue) {
			if (disposed) return;
			const id = ++cueId;
			const prefs = getPrefs();
			const pattern = FEEDBACK_CUES[cue];
			let vibration = prefs.vibration ? 'unavailable' : 'off';
			if (prefs.vibration && canVibrate()) {
				try {
					vibration = navigator.vibrate(pattern.vibrate) ? 'requested' : 'rejected';
				} catch {
					vibration = 'failed';
				}
			}
			log(`feedback ${cue}: sound=${prefs.sound ? 'on' : 'off'}, audio=${ctx?.state ?? 'unavailable'}, vibration=${vibration}`);
			if (!prefs.sound || disposed) return;
			const c = audio();
			if (!c) { log(`feedback ${cue}: audio unavailable`); reportState(); return; }
			try {
				if (c.state !== 'running') {
					// A browser may leave resume() pending until a tap. Never queue old
					// scan cues on its frozen clock to play together much later.
					let timer: ReturnType<typeof setTimeout> | undefined;
					try {
						await Promise.race([resume(c), new Promise<void>((resolve) => { timer = setTimeout(resolve, 300); })]);
					} finally { clearTimeout(timer); }
				}
				if (disposed || id !== cueId || !getPrefs().sound || c.state !== 'running') {
					log(`feedback ${cue}: not scheduled (audio=${c.state}, superseded=${id !== cueId})`);
					reportState();
					return;
				}
				let t = c.currentTime + 0.01;
				for (const tone of pattern.tones) {
					const osc = c.createOscillator();
					const gain = c.createGain();
					const end = t + tone.ms / 1000;
					osc.type = 'sine';
					osc.frequency.value = tone.hz;
					// a short attack and release: no clicks
					gain.gain.setValueAtTime(0, t);
					gain.gain.linearRampToValueAtTime(0.18, t + 0.01);
					gain.gain.linearRampToValueAtTime(0, end);
					osc.connect(gain);
					gain.connect(c.destination);
					osc.start(t);
					osc.stop(end + 0.02);
					osc.onended = () => { osc.disconnect(); gain.disconnect(); };
					t = end + 0.03;
				}
				log(`feedback ${cue}: scheduled (audio=running)`);
			} catch {
				log(`feedback ${cue}: audio scheduling failed`);
			}
		},
		dispose() {
			disposed = true;
			cueId++;
			const c = ctx;
			ctx = null;
			if (c) { c.onstatechange = null; try { void c.close().catch(() => {}); } catch { /* already closed */ } }
		}
	};
}
