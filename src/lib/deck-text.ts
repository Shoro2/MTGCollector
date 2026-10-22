/**
 * Deck lists as text: the import parser for Moxfield, MTG Arena, MTGO and Archidekt
 * exports, and the two export styles. Pure; the server resolves names to printings
 * (src/lib/server/decks.ts).
 */
import type { Board } from './deck';

export type DeckLine = { line: number; quantity: number; name: string; set: string; number: string; foil: boolean; board: Board };
export type DeckLineIssue = { line: number; text: string; message: string };

export const MAX_LIST_CHARS = 200_000;
export const MAX_LIST_LINES = 1000;

const HEADERS: [RegExp, Board | null][] = [
	[/^(commanders?|command zone|oathbreaker)$/, 'commander'],
	[/^(deck|main|main ?deck|mainboard)$/, 'main'],
	[/^(sideboard|side ?board|companion)$/, 'sideboard'],
	[/^(maybeboard|maybe|considering)$/, 'maybeboard'],
	// Arena puts the deck's name under "About"; those lines are not cards.
	[/^about$/, null]
];

/** A section header such as "Sideboard", "// Commander", "SIDEBOARD:" or "Deck (60)". */
function header(text: string): Board | null | undefined {
	const key = text.replace(/^\/\/\s*/, '').replace(/\s*\(\d+\)\s*$/, '').replace(/:$/, '').trim().toLowerCase();
	return HEADERS.find(([pattern]) => pattern.test(key))?.[1];
}

// Archidekt writes categories in brackets ("[Commander{top}]"); they decide the board.
const CATEGORY_BOARDS: [RegExp, Board][] = [[/\bcommander\b/i, 'commander'], [/\bsideboard\b/i, 'sideboard'], [/\bmaybeboard\b/i, 'maybeboard']];

const LINE = /^(?:(\d{1,4})\s*x?\s+)?(.+?)(?:\s+\(([A-Za-z0-9]{2,8})\)(?:\s+([^\s*]+))?)?(?:\s+\*([FE])\*)?$/i;

function cleanName(name: string): string {
	let text = name.replace(/\s+/g, ' ').trim();
	// "Fire/Ice" and "Fire / Ice" are written for split cards; the catalogue says "Fire // Ice".
	if (!text.includes('//')) text = text.replace(/\s*\/\s*/g, ' // ');
	return text;
}

/**
 * Parses a pasted or uploaded deck list. Sections come from headers ("Commander",
 * "Deck", "Sideboard", "Maybeboard", Moxfield's "SIDEBOARD:"), an "SB:" prefix or an
 * Archidekt category. Without any header, two blocks split by a blank line are main deck
 * and sideboard, as MTGO writes them, when the second holds at most 15 cards.
 * Unreadable lines become issues.
 */
export function parseDeckList(text: string): { entries: DeckLine[]; issues: DeckLineIssue[]; implicitSideboard: boolean } {
	if (text.length > MAX_LIST_CHARS) throw new Error('The list is too long (maximum 200,000 characters).');
	const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
	if (lines.filter((l) => l.trim()).length > MAX_LIST_LINES) throw new Error(`Import at most ${MAX_LIST_LINES} lines at a time.`);
	const hasHeaders = lines.some((l) => header(l.trim()) !== undefined);
	const entries: DeckLine[] = [];
	const issues: DeckLineIssue[] = [];
	let board: Board | null = 'main';
	let block = 0;
	const blockOf: number[] = [];
	lines.forEach((raw, index) => {
		const line = index + 1;
		const text = raw.trim();
		if (!text) {
			if (entries.length && blockOf[blockOf.length - 1] === block) block++;
			return;
		}
		const section = header(text);
		if (section !== undefined) {
			board = section;
			return;
		}
		if (board === null || /^(#|\/\/)/.test(text)) return;
		let body = text;
		let lineBoard: Board = board;
		if (/^SB:\s*/i.test(body)) {
			body = body.replace(/^SB:\s*/i, '');
			lineBoard = 'sideboard';
		}
		const category = /\s*\[([^\]]*)\]\s*$/.exec(body);
		if (category) {
			body = body.slice(0, category.index);
			lineBoard = CATEGORY_BOARDS.find(([pattern]) => pattern.test(category[1]))?.[1] ?? lineBoard;
		}
		// Moxfield tags ("#Ramp", "#!Draw") and Archidekt markers trail the card.
		body = body.replace(/\s+#\S.*$/, '').replace(/\s+\^[^^]*\^\s*$/, '').trim();
		const match = LINE.exec(body);
		const quantity = match?.[1] ? Number(match[1]) : 1;
		const name = match ? cleanName(match[2]) : '';
		if (!match || !name || /^\d+$/.test(name)) {
			issues.push({ line, text, message: 'Not a card line. Write it as "1 Card Name" or "1 Card Name (SET) 123".' });
			return;
		}
		if (quantity < 1 || quantity > 999) {
			issues.push({ line, text, message: 'Quantity must be between 1 and 999.' });
			return;
		}
		entries.push({
			line, quantity, name, set: (match[3] ?? '').toLowerCase(), number: match[4] ?? '', foil: (match[5] ?? '').toUpperCase() === 'F', board: lineBoard
		});
		blockOf.push(block);
	});
	let implicitSideboard = false;
	if (!hasHeaders) {
		const last = blockOf.length ? blockOf[blockOf.length - 1] : 0;
		const tail = entries.filter((e, i) => blockOf[i] === last && e.board === 'main');
		if (last === 1 && tail.length && tail.reduce((n, e) => n + e.quantity, 0) <= 15) {
			for (const e of tail) e.board = 'sideboard';
			implicitSideboard = true;
		}
	}
	// MTGO also writes a Commander deck's commander as its sideboard; the server may promote it.
	return { entries, issues, implicitSideboard };
}

export type ExportRow = { board: Board; quantity: number; name: string; set_code: string; collector_number: string; foil: number | boolean };
export type ExportStyle = 'printings' | 'names';

const EXPORT_SECTIONS: [Board, string][] = [['commander', 'Commander'], ['main', 'Deck'], ['sideboard', 'Sideboard'], ['maybeboard', 'Maybeboard']];

/**
 * The deck as text in sections. "printings" writes "1 Name (SET) 123" with *F* for foils
 * (Moxfield, Archidekt and MTG Arena read it); "names" writes "1 Name" only.
 */
export function deckListText(rows: ExportRow[], style: ExportStyle): string {
	const sections: string[] = [];
	for (const [board, title] of EXPORT_SECTIONS) {
		const list = rows.filter((r) => r.board === board).sort((a, b) => a.name.localeCompare(b.name));
		if (!list.length) continue;
		const lines = list.map((r) =>
			style === 'names'
				? `${r.quantity} ${r.name}`
				: `${r.quantity} ${r.name} (${r.set_code.toUpperCase()}) ${r.collector_number}${r.foil ? ' *F*' : ''}`
		);
		sections.push([title, ...lines].join('\n'));
	}
	return sections.join('\n\n') + (sections.length ? '\n' : '');
}
