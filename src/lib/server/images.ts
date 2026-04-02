import { join } from 'node:path';
import { mkdirSync, existsSync, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const imageBaseDir = join(process.cwd(), 'static', 'card-images');

export function getLocalImagePath(setCode: string, collectorNumber: string): string {
	return `/card-images/${setCode}/${collectorNumber}.jpg`;
}

export function getAbsoluteImagePath(setCode: string, collectorNumber: string): string {
	return join(imageBaseDir, setCode, `${collectorNumber}.jpg`);
}

export function imageExists(setCode: string, collectorNumber: string): boolean {
	return existsSync(getAbsoluteImagePath(setCode, collectorNumber));
}

export async function downloadImage(
	imageUrl: string,
	setCode: string,
	collectorNumber: string
): Promise<string> {
	const dir = join(imageBaseDir, setCode);
	mkdirSync(dir, { recursive: true });

	const filePath = getAbsoluteImagePath(setCode, collectorNumber);
	if (existsSync(filePath)) return getLocalImagePath(setCode, collectorNumber);

	const response = await fetch(imageUrl);
	if (!response.ok || !response.body) {
		throw new Error(`Failed to download image: ${response.status}`);
	}

	const fileStream = createWriteStream(filePath);
	// @ts-expect-error Node.js ReadableStream compatibility
	await pipeline(response.body, fileStream);

	return getLocalImagePath(setCode, collectorNumber);
}

export async function downloadImagesForCards(
	cards: Array<{ imageUri: string | null; setCode: string; collectorNumber: string }>,
	onProgress?: (done: number, total: number) => void
): Promise<void> {
	const toDownload = cards.filter(
		(c) => c.imageUri && !imageExists(c.setCode, c.collectorNumber)
	);

	let done = 0;
	const concurrency = 5;

	for (let i = 0; i < toDownload.length; i += concurrency) {
		const batch = toDownload.slice(i, i + concurrency);
		await Promise.allSettled(
			batch.map(async (card) => {
				try {
					await downloadImage(card.imageUri!, card.setCode, card.collectorNumber);
				} catch {
					// Skip failed downloads silently
				}
				done++;
				onProgress?.(done, toDownload.length);
			})
		);
		// Respect Scryfall rate limits (~10 req/s)
		await new Promise((r) => setTimeout(r, 200));
	}
}
