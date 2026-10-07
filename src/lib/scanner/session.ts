import type { Decision, Finish } from './resolve';
import { CONDITIONS, validLanguage } from '../collection-fields';

export type ScanSession = { setCode: string; language: string; finish: Finish; condition: string; location: string };
export const defaultSession = (): ScanSession => ({ setCode: '', language: '', finish: 'unknown', condition: 'near_mint', location: '' });

export function restoreSession(raw: unknown, sets: string[]): ScanSession {
	const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
	return {
		setCode: typeof value.setCode === 'string' && sets.includes(value.setCode) ? value.setCode : '',
		language: validLanguage(value.language) ? value.language : '',
		finish: value.finish === 'foil' || value.finish === 'nonfoil' ? value.finish : 'unknown',
		condition: CONDITIONS.some(c => c.value === value.condition) ? value.condition as string : 'near_mint',
		location: typeof value.location === 'string' && value.location.length <= 120 && !/[\u0000-\u001f]/.test(value.location) ? value.location.trim() : ''
	};
}

/** A user-selected set can narrow an established identity, but never erase contrary evidence. */
export function applySessionSet(decision: Decision, setCode: string, observedSets: string[] = []): Decision {
	if (!setCode) return decision;
	const inSet = (row: Record<string, unknown>) => row.set_code === setCode;
	const candidates = decision.printing.candidates.filter(inSet);
	const row = decision.printing.row;
	const reasons = [...decision.reasons, `Session set: ${setCode.toUpperCase()} (selected by user)`];
	if (row && !inSet(row) || decision.identity.state === 'confirmed' && (!row && !candidates.length || observedSets.some(s => s !== setCode))) {
		return { ...decision, identity: { ...decision.identity, state: 'conflict' },
			printing: { state: 'conflict', row: null, candidates: row ? [row, ...candidates.filter(c => c.id !== row.id)] : decision.printing.candidates },
			reasons: [...reasons, 'Detected printing conflicts with the selected session set. Review it or change the set.'] };
	}
	if (decision.identity.state !== 'confirmed' || row) return { ...decision, reasons };
	return { ...decision, reasons, printing: candidates.length === 1
		? { state: 'confirmed', row: candidates[0], candidates }
		: { state: 'unknown', row: null, candidates } };
}
