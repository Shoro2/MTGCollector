// Format legality as Scryfall reports it (`cards.legalities`, one JSON object per printing).
// Pure helpers for the legality grid on card and printing pages.

export type LegalityStatus = 'legal' | 'restricted' | 'banned' | 'not_legal';

export interface FormatLegality {
	format: string;
	label: string;
	group: 'constructed' | 'multiplayer';
	status: LegalityStatus;
}

// Scryfall format keys in display order. Keys Scryfall adds later still show up
// (after these, with a generated label), so a new format never disappears silently.
const FORMATS: { key: string; label: string; group: FormatLegality['group'] }[] = [
	{ key: 'standard', label: 'Standard', group: 'constructed' },
	{ key: 'pioneer', label: 'Pioneer', group: 'constructed' },
	{ key: 'modern', label: 'Modern', group: 'constructed' },
	{ key: 'legacy', label: 'Legacy', group: 'constructed' },
	{ key: 'vintage', label: 'Vintage', group: 'constructed' },
	{ key: 'pauper', label: 'Pauper', group: 'constructed' },
	{ key: 'premodern', label: 'Premodern', group: 'constructed' },
	{ key: 'oldschool', label: 'Old School', group: 'constructed' },
	{ key: 'penny', label: 'Penny Dreadful', group: 'constructed' },
	{ key: 'future', label: 'Future Standard', group: 'constructed' },
	{ key: 'alchemy', label: 'Alchemy', group: 'constructed' },
	{ key: 'historic', label: 'Historic', group: 'constructed' },
	{ key: 'timeless', label: 'Timeless', group: 'constructed' },
	{ key: 'explorer', label: 'Explorer', group: 'constructed' },
	{ key: 'gladiator', label: 'Gladiator', group: 'constructed' },
	{ key: 'commander', label: 'Commander', group: 'multiplayer' },
	{ key: 'duel', label: 'Duel Commander', group: 'multiplayer' },
	{ key: 'paupercommander', label: 'Pauper Commander', group: 'multiplayer' },
	{ key: 'predh', label: 'PreDH', group: 'multiplayer' },
	{ key: 'oathbreaker', label: 'Oathbreaker', group: 'multiplayer' },
	{ key: 'brawl', label: 'Brawl', group: 'multiplayer' },
	{ key: 'standardbrawl', label: 'Standard Brawl', group: 'multiplayer' },
	{ key: 'historicbrawl', label: 'Historic Brawl', group: 'multiplayer' }
];

const KNOWN = new Map(FORMATS.map((f, i) => [f.key, { ...f, order: i }]));

export const LEGALITY_LABELS: Record<LegalityStatus, string> = {
	legal: 'Legal',
	restricted: 'Restricted',
	banned: 'Banned',
	not_legal: 'Not legal'
};

function normalizeStatus(value: unknown): LegalityStatus {
	return value === 'legal' || value === 'restricted' || value === 'banned' ? value : 'not_legal';
}

function fallbackLabel(key: string): string {
	return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Readable name of a Scryfall format key ("paupercommander" -> "Pauper Commander"). */
export function formatLabel(key: string): string {
	return KNOWN.get(key)?.label ?? fallbackLabel(key);
}

/** Parses `cards.legalities` (JSON text or an object) into an ordered list; invalid input gives []. */
export function formatLegalities(raw: string | Record<string, unknown> | null | undefined): FormatLegality[] {
	let data: unknown = raw;
	if (typeof raw === 'string') {
		try {
			data = JSON.parse(raw);
		} catch {
			return [];
		}
	}
	if (!data || typeof data !== 'object' || Array.isArray(data)) return [];

	return Object.entries(data as Record<string, unknown>)
		.map(([key, value]) => {
			const known = KNOWN.get(key);
			return {
				format: key,
				label: known?.label ?? fallbackLabel(key),
				group: known?.group ?? 'constructed',
				status: normalizeStatus(value),
				order: known?.order ?? FORMATS.length
			};
		})
		.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
		.map(({ order: _order, ...entry }) => entry);
}
