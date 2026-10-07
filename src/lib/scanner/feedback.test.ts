import { afterEach, describe, expect, it, vi } from 'vitest';
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
	afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
	function mockAudio(initial: AudioContextState = 'suspended') {
		const tones: number[] = [];
		const context = {
			state: initial, currentTime: 0, destination: {}, onstatechange: null as null | (() => void),
			resume: vi.fn(() => new Promise<void>(() => {})),
			close: vi.fn(async () => {}),
			createOscillator: () => {
				const osc = { type: '', frequency: { value: 0 }, connect() {}, disconnect() {}, stop() {}, start() { tones.push(osc.frequency.value); } };
				return osc;
			},
			createGain: () => ({ gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} })
		};
		vi.stubGlobal('window', { AudioContext: class { constructor() { return context; } } });
		return { context, tones };
	}
	it('expires a blocked cue without playing it later when a user enables sound', async () => {
		vi.useFakeTimers();
		const { context, tones } = mockAudio();
		const messages: string[] = [];
		const feedback = createScanFeedback(() => ({ sound: true, vibration: false }), { log: m => messages.push(m) });
		feedback.unlock();
		const blocked = feedback.play('capture');
		await vi.advanceTimersByTimeAsync(301);
		await blocked;
		expect(tones).toEqual([]);
		expect(messages.some(m => m.includes('not scheduled (audio=suspended'))).toBe(true);
		const resumes = context.resume.mock.calls.length;
		feedback.unlock();
		expect(context.resume.mock.calls.length).toBe(resumes + 1);
		context.state = 'running'; context.onstatechange?.();
		await feedback.play('identified');
		expect(tones).toEqual([660, 990]);
		feedback.dispose();
	});
	it('waits for a prompt resume before scheduling a capture cue', async () => {
		const { context, tones } = mockAudio();
		context.resume.mockImplementation(async () => { context.state = 'running'; });
		const feedback = createScanFeedback(() => ({ sound: true, vibration: false }));
		await feedback.play('capture');
		expect(tones).toEqual([880]);
		feedback.dispose();
	});
	it('does not schedule a pending cue after disposal, a newer cue or switching sound off', async () => {
		vi.useFakeTimers();
		for (const action of ['dispose', 'newer cue', 'mute']) {
			const { context, tones } = mockAudio();
			let sound = true;
			const feedback = createScanFeedback(() => ({ sound, vibration: false }));
			const pending = feedback.play('capture');
			context.state = 'running';
			if (action === 'dispose') feedback.dispose();
			else if (action === 'mute') sound = false;
			else await feedback.play('unresolved');
			await vi.advanceTimersByTimeAsync(301); await pending;
			expect(tones).toEqual(action === 'newer cue' ? [330] : []);
			feedback.dispose();
		}
	});
	it('reports rejected resume and keeps muted cues silent', async () => {
		const { context, tones } = mockAudio();
		context.resume.mockRejectedValue(new Error('blocked'));
		const messages: string[] = [];
		let sound = true;
		const feedback = createScanFeedback(() => ({ sound, vibration: false }), { log: m => messages.push(m) });
		await feedback.play('capture');
		expect(messages).toContain('audio resume rejected');
		context.state = 'running'; sound = false;
		await feedback.play('identified');
		expect(tones).toEqual([]);
		feedback.dispose();
	});
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
