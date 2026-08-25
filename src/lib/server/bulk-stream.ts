import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';

/**
 * Async iterator that yields each card object of a Scryfall bulk-data file
 * without loading the whole document into memory.
 *
 * Handles both payload shapes, because Scryfall switched formats:
 *  - **JSONL** (current): one JSON object per line, served gzipped.
 *  - **JSON array** (legacy): a single top-level `[ {...}, {...} ]` document.
 *
 * The scanner just walks the byte stream and emits an object every time brace
 * depth returns to zero, so array punctuation and newlines are both simply
 * skipped — no format flag is needed. Files ending in `.gz` are decompressed on
 * the fly.
 *
 * Memory stays proportional to the size of a single card object (~a few KB)
 * rather than the whole payload.
 */
export async function* parseScryfallBulkStream<T>(
	filePath: string
): AsyncGenerator<T, void, unknown> {
	const raw = createReadStream(filePath, { highWaterMark: 1 << 20 });
	const stream = filePath.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
	stream.setEncoding('utf-8');

	let buffer = '';
	let cursor = 0;
	let depth = 0;
	let inString = false;
	let escape = false;
	let objectStart = -1;

	for await (const chunk of stream) {
		buffer += chunk;

		while (cursor < buffer.length) {
			const ch = buffer[cursor];

			if (escape) {
				escape = false;
				cursor++;
				continue;
			}

			if (inString) {
				if (ch === '\\') escape = true;
				else if (ch === '"') inString = false;
				cursor++;
				continue;
			}

			if (ch === '"') {
				inString = true;
				cursor++;
				continue;
			}

			if (ch === '{') {
				if (depth === 0) objectStart = cursor;
				depth++;
				cursor++;
				continue;
			}

			if (ch === '}') {
				depth--;
				cursor++;
				if (depth === 0 && objectStart !== -1) {
					yield JSON.parse(buffer.slice(objectStart, cursor)) as T;
					objectStart = -1;
				}
				continue;
			}

			cursor++;
		}

		// Trim processed content so the buffer stays bounded.
		if (objectStart === -1) {
			buffer = '';
			cursor = 0;
		} else {
			buffer = buffer.slice(objectStart);
			cursor -= objectStart;
			objectStart = 0;
		}
	}
}
