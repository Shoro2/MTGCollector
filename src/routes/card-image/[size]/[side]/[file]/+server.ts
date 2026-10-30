import { join } from 'node:path';
import { error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { createCardImageCache } from '$lib/server/card-image-cache';
import { CARD_IMAGE_SIZES, parseScryfallImage, type CardImageSize } from '$lib/card-image';
import type { Statement } from 'better-sqlite3';

// Card images from this host (src/lib/card-image.ts, src/lib/server/card-image-cache.ts).
const cache = createCardImageCache({ dir: join(process.cwd(), 'data', 'card-images') });

const FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jpg$/;

// Prepared on first use: the build discovers routes before initDb() created the tables.
let frontStmt: Statement<[string], { image_uri: string | null }> | null = null;
let backStmt: Statement<[string], { image_uri: string | null }> | null = null;

function currentImageUri(id: string, side: string): string | null {
	if (side === 'front') {
		frontStmt ??= sqlite.prepare('SELECT image_uri FROM cards WHERE id = ?');
		return frontStmt.get(id)?.image_uri ?? null;
	}
	backStmt ??= sqlite.prepare(
		"SELECT image_uri FROM card_faces WHERE card_id = ? AND image_uri LIKE '%/back/%' ORDER BY face_index LIMIT 1"
	);
	return backStmt.get(id)?.image_uri ?? null;
}

export async function GET({ params, url }) {
	const size = params.size as CardImageSize;
	const file = FILE.exec(params.file);
	if (!CARD_IMAGE_SIZES.includes(size) || (params.side !== 'front' && params.side !== 'back') || !file) error(404, 'Not found');

	// The catalogue's URL decides what is fetched, never the request: only printings we list are cached.
	const image = parseScryfallImage(currentImageUri(file[1], params.side));
	if (!image || image.id !== file[1] || image.side !== params.side) error(404, 'Not found');

	const result = await cache.get(image, size);
	if (!result.ok) {
		return new Response(null, {
			status: result.status,
			headers: { 'Cache-Control': result.status === 404 ? 'public, max-age=86400' : 'no-store' }
		});
	}
	// A URL with the current version never changes; an old or missing version may be re-scanned later.
	const current = image.version !== null && url.searchParams.get('v') === image.version;
	return new Response(new Uint8Array(result.body), {
		headers: {
			'Content-Type': 'image/jpeg',
			'Content-Length': String(result.body.length),
			'Cache-Control': current ? 'public, max-age=31536000, immutable' : 'public, max-age=86400',
			'X-Card-Image-Cache': result.cached ? 'hit' : 'miss'
		}
	});
}
