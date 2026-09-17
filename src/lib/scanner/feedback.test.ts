import { describe, expect, it } from 'vitest';
import { DEFAULT_FEEDBACK_PREFS, FEEDBACK_CUES, canVibrate, createScanFeedback, loadFeedbackPrefs, saveFeedbackPrefs } from './feedback';

const memoryStorage = (initial: Record<string, string> = {}) => {
	const data = { ...initial };
	return { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v), data };
};

describe('FEEDBACK_CUES', () => {
	it('keeps the capture tick shorter than both result cues, in sound and in vibration', () => {
		const soundMs = (c: keyof typeof FEEDBACK_CUES) => FEEDBACK_CUES[c].tones.reduce((s, t) => s + t.ms, 0);
		const buzzMs = (c: keyof typeof FEEDBACK_CUES) => FEEDBACK_CUES[c].vibrate.reduce((s, v) => s + v, 0);
		expect(soundMs('capture')).toBeLessThan(soundMs('identified'));
		expect(soundMs('capture')).toBeLessThan(soundMs('unresolved'));
		expect(buzzMs('capture')).toBeLessThan(buzzMs('identified'));
		expect(buzzMs('capture')).toBeLessThan(buzzMs('unresolved'));
	});

	it('tells "identified" from "unresolved" by ear: rising two-tone versus one low tone', () => {
		const ok = FEEDBACK_CUES.identified.tones, bad = FEEDBACK_CUES.unresolved.tones;
		expect(ok).toHaveLength(2);
		expect(ok[1].hz).toBeGreaterThan(ok[0].hz);
		expect(bad).toHaveLength(1);
		expect(bad[0].hz).toBeLessThan(ok[0].hz);
	});
});

describe('feedback preferences', () => {
	it('defaults to sound and vibration on, also without storage or with unreadable content', () => {
		expect(loadFeedbackPrefs(null)).toEqual(DEFAULT_FEEDBACK_PREFS);
		expect(loadFeedbackPrefs(memoryStorage())).toEqual(DEFAULT_FEEDBACK_PREFS);
		expect(loadFeedbackPrefs(memoryStorage({ 'mtg.scan.feedback': '{broken' }))).toEqual(DEFAULT_FEEDBACK_PREFS);
		expect(loadFeedbackPrefs(memoryStorage({ 'mtg.scan.feedback': '{"sound":"yes"}' }))).toEqual(DEFAULT_FEEDBACK_PREFS);
	});

	it('round-trips through storage and survives a storage that throws', () => {
		const storage = memoryStorage();
		saveFeedbackPrefs({ sound: false, vibration: true }, storage);
		expect(loadFeedbackPrefs(storage)).toEqual({ sound: false, vibration: true });
		const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
		expect(() => saveFeedbackPrefs({ sound: true, vibration: false }, broken)).not.toThrow();
		expect(loadFeedbackPrefs(broken)).toEqual(DEFAULT_FEEDBACK_PREFS);
	});
});

describe('createScanFeedback', () => {
	it('is silent and harmless where there is no audio context and no vibration (Node, old browsers)', () => {
		expect(canVibrate()).toBe(false);
		const feedback = createScanFeedback(() => ({ sound: true, vibration: true }));
		expect(() => {
			feedback.unlock();
			feedback.play('capture');
			feedback.play('identified');
			feedback.play('unresolved');
			feedback.dispose();
		}).not.toThrow();
	});
});
