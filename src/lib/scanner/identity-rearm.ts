/** A second rearm channel for cards that collide under the coarse scene fingerprint. */
import { ART_CONFIRM_ALONE, ART_MARGIN } from './resolve';

export type ReferenceMatch = { row: { name: string }; distance: number };

/** Collapse reprints before testing ambiguity. A weak artwork match cannot unlock a capture. */
export function referenceIdentity(matches: ReferenceMatch[]): string | null {
	const names = new Map<string, number>();
	for (const m of matches) {
		if (!m.row?.name || !Number.isFinite(m.distance) || m.distance < 0) continue;
		names.set(m.row.name, Math.min(names.get(m.row.name) ?? Infinity, m.distance));
	}
	const ranked = [...names].sort((a, b) => a[1] - b[1]);
	if (!ranked.length || ranked[0][1] > ART_CONFIRM_ALONE) return null;
	if (ranked[1] && ranked[1][1] - ranked[0][1] < ART_MARGIN) return null;
	return ranked[0][0];
}

export class IdentityRearm {
	private candidate: { name: string; since: number; last: number } | null = null;
	reset() { this.candidate = null; }
	/** Two separated observations must identify the same new card. Never establishes its printing. */
	observe(capturedName: string | null, currentName: string | null, now: number): boolean {
		if (!capturedName || !currentName || capturedName === currentName) { this.reset(); return false; }
		const p = this.candidate;
		if (!p || p.name !== currentName || now - p.last > 5000 || now < p.last) {
			this.candidate = { name: currentName, since: now, last: now };
			return false;
		}
		p.last = now;
		return now - p.since >= 700;
	}
}
