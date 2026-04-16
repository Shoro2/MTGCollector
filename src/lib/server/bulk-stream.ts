import { createReadStream } from 'node:fs';

/**
 * Async iterator that yields each element of a Scryfall bulk-data JSON array
 * without loading the whole document into memory. The bulk files are a single
 * top-level JSON array (`[ {...}, {...}, ... ]`), so we walk the byte stream
 * and emit objects as we balance braces at the top level.
 *
 * Memory stays proportional to the size of a single card object (~a few KB)
 * rather than the whole ~600 MB payload.
 */
export async function* parseScryfallBulkStream<T>(
	filePath: string
): AsyncGenerator<T, void, unknown> {
	const stream = createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 1 << 20 });

	let buffer = '';
	let cursor = 0;
	let depth = 0;
	let inString = false;
	let escape = false;
	let inArray = false;
	let objectStart = -1;

	for await (const chunk of stream) {
		buffer += chunk;

		while (cursor < buffer.length) {
			const ch = buffer[cursor];

			if (!inArray) {
				if (ch === '[') inArray = true;
				cursor++;
				continue;
			}

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

			if (ch === ']' && depth === 0) {
				return;
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
