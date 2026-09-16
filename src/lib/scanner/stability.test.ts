import { describe, it, expect } from 'vitest';
import { SceneStabilizer, sceneSignature } from './stability';

// A card ~600 px tall in a 1080x1920 portrait phone frame.
const card = (x: number, y: number, w = 420, h = 600) => ({ rect: { x, y, width: w, height: h } });

// Feed the same scene every `stepMs` until at least `totalMs` have elapsed
// since `from`; returns the timestamp of the last frame fed.
function hold(s: SceneStabilizer, rects: ReturnType<typeof card>[], from: number, totalMs: number, stepMs: number): number {
	let t = from;
	for (;;) {
		s.update(rects, t);
		if (t >= from + totalMs) return t;
		t += stepMs;
	}
}

describe('SceneStabilizer', () => {
	it('is never stable for an empty scene', () => {
		const s = new SceneStabilizer();
		s.update([], 0);
		expect(s.isStable([], 0)).toBe(false);
		expect(s.progress([], 0)).toBe(0);
	});

	it('settles after minStableMs of a still rect (fast device, 6 fps)', () => {
		const s = new SceneStabilizer({ minStableMs: 700, minSamples: 3 });
		const scene = [card(300, 600)];
		// 0..600 ms: not yet
		let t = hold(s, scene, 0, 600, 166);
		expect(s.isStable(scene, t)).toBe(false);
		expect(s.progress(scene, t)).toBeLessThan(1);
		// at 700 ms: stable
		t = hold(s, scene, t + 166, 200, 166);
		expect(s.isStable(scene, t)).toBe(true);
		expect(s.progress(scene, t)).toBe(1);
	});

	it('waits the same wall-clock time on a slow device (2.5 fps)', () => {
		const s = new SceneStabilizer({ minStableMs: 700, minSamples: 3 });
		const scene = [card(300, 600)];
		s.update(scene, 0);
		s.update(scene, 400);
		expect(s.isStable(scene, 400)).toBe(false);
		s.update(scene, 800);
		// 800 ms held and 3 samples seen → stable, even though only 3 frames arrived.
		expect(s.isStable(scene, 800)).toBe(true);
	});

	it('needs minSamples even when enough time has passed', () => {
		const s = new SceneStabilizer({ minStableMs: 700, minSamples: 3, expireMs: 5000 });
		const scene = [card(300, 600)];
		s.update(scene, 0);
		s.update(scene, 900);
		expect(s.isStable(scene, 900)).toBe(false);
		expect(s.progress(scene, 900)).toBeCloseTo(2 / 3, 5);
	});

	it('tolerates hand jitter within 5% of the card size', () => {
		const s = new SceneStabilizer({ minStableMs: 700, minSamples: 3 });
		let t = 0;
		// ±12 px jitter on a 600 px card (tolerance 30 px)
		for (let i = 0; i < 8; i++, t += 166) {
			const dx = i % 2 === 0 ? 12 : -12;
			s.update([card(300 + dx, 600 - dx)], t);
		}
		const last = card(300, 600);
		expect(s.isStable([last], t)).toBe(true);
	});

	it('restarts the steady timer when the card moves too far', () => {
		const s = new SceneStabilizer({ minStableMs: 700, minSamples: 3 });
		let t = hold(s, [card(300, 600)], 0, 800, 166);
		expect(s.isStable([card(300, 600)], t)).toBe(true);
		// Slide by 80 px (still associated with the same tracker, but beyond drift)
		const moved = [card(380, 600)];
		t += 166;
		s.update(moved, t);
		expect(s.isStable(moved, t)).toBe(false);
		expect(s.progress(moved, t)).toBeLessThan(0.5);
		// Holding still again for the full window settles it once more.
		t = hold(s, moved, t + 166, 800, 166);
		expect(s.isStable(moved, t)).toBe(true);
	});

	it('starts a new tracker for a rect that jumps across the frame', () => {
		const s = new SceneStabilizer({ minStableMs: 700, minSamples: 3 });
		let t = hold(s, [card(100, 100)], 0, 800, 166);
		const jumped = [card(600, 1000)];
		t += 166;
		s.update(jumped, t);
		expect(s.trackerCount).toBe(2);
		expect(s.isStable(jumped, t)).toBe(false);
	});

	it('requires every rect in a multi-card scene to settle', () => {
		const s = new SceneStabilizer({ minStableMs: 700, minSamples: 3 });
		const a = card(50, 600);
		const t = hold(s, [a], 0, 800, 166);
		expect(s.isStable([a], t)).toBe(true);
		// A second card enters the frame: scene as a whole is unstable again.
		const b = card(600, 600);
		s.update([a, b], t + 166);
		expect(s.isStable([a, b], t + 166)).toBe(false);
		expect(s.isRectStable(a, t + 166)).toBe(true);
		expect(s.isRectStable(b, t + 166)).toBe(false);
	});

	it('drops trackers that have not been seen for expireMs', () => {
		const s = new SceneStabilizer({ expireMs: 500 });
		s.update([card(300, 600)], 0);
		expect(s.trackerCount).toBe(1);
		s.update([], 400);
		expect(s.trackerCount).toBe(1);
		s.update([], 600);
		expect(s.trackerCount).toBe(0);
	});

	it('scales the tolerances with the card size', () => {
		// A small far-away card (60 px) gets the 10 px floor; a 12 px wobble breaks it.
		const s = new SceneStabilizer({ minStableMs: 700, minSamples: 3 });
		let t = 0;
		for (let i = 0; i < 8; i++, t += 166) {
			const dx = i % 2 === 0 ? 12 : -12;
			s.update([card(300 + dx, 600, 42, 60)], t);
		}
		expect(s.isStable([card(300, 600, 42, 60)], t)).toBe(false);
	});

	it('reset forgets all trackers', () => {
		const s = new SceneStabilizer();
		s.update([card(300, 600)], 0);
		s.reset();
		expect(s.trackerCount).toBe(0);
	});
});

describe('sceneSignature', () => {
	it('is order independent', () => {
		const a = card(100, 100);
		const b = card(700, 900);
		expect(sceneSignature([a, b], 30)).toBe(sceneSignature([b, a], 30));
	});

	it('ignores jitter smaller than the cell size', () => {
		expect(sceneSignature([card(100, 100)], 30)).toBe(sceneSignature([card(104, 97)], 30));
	});

	it('changes when a card moves by more than a cell', () => {
		expect(sceneSignature([card(100, 100)], 30)).not.toBe(sceneSignature([card(200, 100)], 30));
	});

	it('is empty for an empty scene', () => {
		expect(sceneSignature([], 30)).toBe('');
	});
});
