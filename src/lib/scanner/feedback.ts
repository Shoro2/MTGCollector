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
	play(cue: FeedbackCue): void;
	dispose(): void;
};

export function createScanFeedback(getPrefs: () => FeedbackPrefs): ScanFeedback {
	let ctx: AudioContext | null = null;
	const audio = (): AudioContext | null => {
		if (ctx) return ctx;
		if (typeof window === 'undefined') return null;
		const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!AC) return null;
		try {
			ctx = new AC();
		} catch {
			ctx = null;
		}
		return ctx;
	};
	const resume = (c: AudioContext) => {
		if (c.state === 'suspended') void c.resume().catch(() => {});
	};
	return {
		unlock() {
			const c = audio();
			if (c) resume(c);
		},
		play(cue) {
			const prefs = getPrefs();
			const pattern = FEEDBACK_CUES[cue];
			if (prefs.vibration && canVibrate()) {
				try {
					navigator.vibrate(pattern.vibrate);
				} catch {
					/* ignored */
				}
			}
			if (!prefs.sound) return;
			const c = audio();
			if (!c) return;
			try {
				resume(c);
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
					t = end + 0.03;
				}
			} catch {
				/* a blocked or closed context must not break the scan */
			}
		},
		dispose() {
			const c = ctx;
			ctx = null;
			if (c) void c.close().catch(() => {});
		}
	};
}
