import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createRateLimiter } from '$lib/server/rate-limit';
import { listScanLogs, readScanLog, writeScanLog, SCAN_LOG_MAX_BYTES } from '$lib/server/scan-logs';

// The scan page posts its debug log at the end of every scan (and when a live
// session is left without a capture). Public like /scan itself, so it is
// rate-limited per address and capped in size; only admins can read logs back.
const limiter = createRateLimiter(30, 60_000);

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);

export const POST: RequestHandler = async ({ request, locals, getClientAddress }) => {
	if (!limiter.check(getClientAddress())) return json({ ok: false, message: 'Too many logs' }, { status: 429 });
	const raw = await request.text();
	// A log is at most SCAN_LOG_MAX_BYTES after truncation; refuse anything wildly larger before parsing it.
	if (raw.length > SCAN_LOG_MAX_BYTES * 4) return json({ ok: false, message: 'Log too large' }, { status: 413 });
	let body: Record<string, unknown>;
	try {
		const parsed = JSON.parse(raw);
		body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch {
		return json({ ok: false, message: 'Malformed JSON' }, { status: 400 });
	}
	const text = str(body.text);
	if (text.trim() === '') return json({ ok: false, message: 'Empty log' }, { status: 400 });
	const { name } = writeScanLog({
		mode: str(body.mode),
		source: str(body.source),
		summary: str(body.summary),
		cards: num(body.cards),
		identified: num(body.identified),
		likely: num(body.likely),
		wallMs: num(body.wallMs),
		userAgent: request.headers.get('user-agent') ?? '',
		userId: locals.user?.id ?? null,
		version: str(body.version),
		text
	});
	return json({ ok: true, name });
};

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user?.isAdmin) throw error(403, 'Forbidden');
	const name = url.searchParams.get('name');
	if (name) {
		const log = readScanLog(name);
		if (!log) throw error(404, 'Not found');
		return json(log);
	}
	const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
	return json({ logs: listScanLogs(limit) });
};
