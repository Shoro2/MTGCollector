import { json, error } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';
import { decryptSecret, encryptSecret, isEncrypted } from '$lib/server/crypto';
import type { RequestHandler } from './$types';

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
	// Opportunistically re-encrypt legacy plaintext keys so the next request
	// reads an encrypted value.
	if (!isEncrypted(stored)) {
		try {
			sqlite.prepare('UPDATE users SET google_vision_api_key = ? WHERE id = ?')
				.run(encryptSecret(apiKey), locals.user.id);
		} catch { /* ignore, plaintext still works */ }
	}

	const { images } = await request.json() as { images: string[] };
	if (!images?.length) {
		throw error(400, 'No images provided');
	}
	if (images.length > 16) {
		throw error(400, 'Maximum 16 images per request');
	}

	// Build batch request (up to 16 images per API call)
	const requests = images.map((imageBase64: string) => ({
		image: {
			content: imageBase64.replace(/^data:image\/\w+;base64,/, '')
		},
		features: [{ type: 'TEXT_DETECTION' }]
	}));

	const response = await globalThis.fetch(
		`https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ requests })
		}
	);

	if (!response.ok) {
		const errText = await response.text();
		console.error('[OCR] Vision API error:', response.status, errText);
		throw error(502, `Vision API error: ${response.status}`);
	}

	const data = await response.json();
	const results = data.responses.map((r: any) => {
		const text = r.textAnnotations?.[0]?.description ?? '';
		return text.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
	});

	// Track API usage
	try {
		sqlite.prepare(
			'INSERT INTO api_usage (service, endpoint, request_count, image_count, user_id) VALUES (?, ?, ?, ?, ?)'
		).run('google_vision', 'TEXT_DETECTION', 1, images.length, locals.user?.id ?? null);
	} catch { /* don't fail the request if tracking fails */ }

	return json({ results });
};
