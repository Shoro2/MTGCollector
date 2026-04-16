import { json, error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { decryptSecret, encryptSecret, isEncrypted } from '$lib/server/crypto';
import type { RequestHandler } from './$types';

const MAX_IMAGES_PER_REQUEST = 16;
// Google Vision accepts base64-encoded payloads up to ~10 MB per image plus
// overhead. Cap the total request body so a single request can't DoS us.
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PER_IMAGE_BYTES = 5 * 1024 * 1024;
// Daily per-user request cap on the Vision endpoint. Each request may carry
// up to 16 images; this translates to at most DAILY_VISION_REQUEST_LIMIT * 16
// Vision billing units per user per day.
const DAILY_VISION_REQUEST_LIMIT = 200;

function estimateBase64Bytes(s: string): number {
	// 4 base64 chars → 3 bytes. Stripping the data-URI prefix first.
	const body = s.replace(/^data:image\/\w+;base64,/, '');
	return Math.floor((body.length * 3) / 4);
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		throw error(401, 'Unauthorized');
	}

	const row = sqlite.prepare(
		'SELECT google_vision_api_key FROM users WHERE id = ?'
	).get(locals.user.id) as { google_vision_api_key: string | null } | undefined;
	const stored = row?.google_vision_api_key;
	if (!stored) {
		throw error(403, 'No Google Vision API key configured. Add one in /settings.');
	}
	const apiKey = decryptSecret(stored);
	if (!apiKey) {
		throw error(500, 'Stored Google Vision API key is unreadable. Re-enter it in /settings.');
	}
	if (!isEncrypted(stored)) {
		try {
			sqlite.prepare('UPDATE users SET google_vision_api_key = ? WHERE id = ?')
				.run(encryptSecret(apiKey), locals.user.id);
		} catch { /* ignore, plaintext still works */ }
	}

	// Daily rate limit. Uses the existing api_usage table as the ledger.
	const usage = sqlite.prepare(
		`SELECT COUNT(*) as count FROM api_usage
		 WHERE user_id = ? AND service = 'google_vision'
		   AND created_at >= datetime('now', '-1 day')`
	).get(locals.user.id) as { count: number };
	if (usage.count >= DAILY_VISION_REQUEST_LIMIT) {
		throw error(429, `Daily Vision API request limit of ${DAILY_VISION_REQUEST_LIMIT} reached. Try again tomorrow.`);
	}

	let payload: { images?: unknown };
	try {
		payload = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const images = payload?.images;
	if (!Array.isArray(images) || images.length === 0) {
		throw error(400, 'No images provided');
	}
	if (images.length > MAX_IMAGES_PER_REQUEST) {
		throw error(400, `Maximum ${MAX_IMAGES_PER_REQUEST} images per request`);
	}
	for (const img of images) {
		if (typeof img !== 'string') {
			throw error(400, 'Each image must be a base64-encoded string');
		}
	}
	const imageStrings = images as string[];

	let totalBytes = 0;
	for (const img of imageStrings) {
		const bytes = estimateBase64Bytes(img);
		if (bytes > MAX_PER_IMAGE_BYTES) {
			throw error(413, 'Image too large (>5 MB)');
		}
		totalBytes += bytes;
	}
	if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
		throw error(413, 'Request too large (>20 MB total)');
	}

	const requests = imageStrings.map((imageBase64) => ({
		image: {
			content: imageBase64.replace(/^data:image\/\w+;base64,/, '')
		},
		features: [{ type: 'TEXT_DETECTION' }]
	}));

	const response = await globalThis.fetch(
		`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ requests })
		}
	);

	if (!response.ok) {
		// Don't echo response text, which may include request metadata that
		// references the API key (Google's errors sometimes leak it in URLs).
		console.error('[OCR] Vision API error status:', response.status);
		throw error(502, `Vision API error: ${response.status}`);
	}

	const data = await response.json();
	const results = (data.responses ?? []).map((r: { textAnnotations?: Array<{ description?: string }> }) => {
		const text = r.textAnnotations?.[0]?.description ?? '';
		return text.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
	});

	try {
		sqlite.prepare(
			'INSERT INTO api_usage (service, endpoint, request_count, image_count, user_id) VALUES (?, ?, ?, ?, ?)'
		).run('google_vision', 'TEXT_DETECTION', 1, imageStrings.length, locals.user.id);
	} catch { /* don't fail the request if tracking fails */ }

	return json({ results });
};
