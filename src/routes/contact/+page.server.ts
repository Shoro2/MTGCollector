import { sqlite } from '$lib/server/db';
import { fail } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	return { turnstileSiteKey: publicEnv.PUBLIC_TURNSTILE_SITE_KEY ?? null };
};

async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
	const secret = env.TURNSTILE_SECRET_KEY;
	if (!secret) return true; // Turnstile not configured — skip verification
	if (!token) return false;
	try {
		const body = new URLSearchParams({ secret, response: token, remoteip: ip });
		const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
			method: 'POST',
			body
		});
		const data = (await res.json()) as { success?: boolean };
		return data.success === true;
	} catch {
		return false;
	}
}

// Simple in-memory rate limit: max 3 submissions per IP per hour.
const submissions = new Map<string, number[]>();
const RATE_LIMIT = 3;
const WINDOW_MS = 60 * 60 * 1000;

function isRateLimited(ipHash: string): boolean {
	const now = Date.now();
	const history = (submissions.get(ipHash) ?? []).filter((t) => now - t < WINDOW_MS);
	if (history.length >= RATE_LIMIT) {
		submissions.set(ipHash, history);
		return true;
	}
	history.push(now);
	submissions.set(ipHash, history);
	return false;
}

export const actions: Actions = {
	default: async ({ request, getClientAddress }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const email = String(form.get('email') ?? '').trim();
		const subject = String(form.get('subject') ?? '').trim();
		const message = String(form.get('message') ?? '').trim();
		// Honeypot: hidden field, must stay empty. Bots filling all inputs will trip it.
		const honeypot = String(form.get('website') ?? '').trim();
		// Time trap: form has to be on screen for at least 2 seconds.
		const loadedAt = Number(form.get('loadedAt') ?? 0);

		const values = { name, email, subject, message };

		if (honeypot) {
			// Silently accept to not tip off bots.
			return { success: true, values: { name: '', email: '', subject: '', message: '' } };
		}

		if (!loadedAt || Date.now() - loadedAt < 2000) {
			return fail(400, { error: 'Bitte versuche es erneut.', values });
		}

		if (!name || name.length < 2 || name.length > 100) {
			return fail(400, { error: 'Bitte gib einen gültigen Namen an.', values });
		}
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
			return fail(400, { error: 'Bitte gib eine gültige E-Mail-Adresse an.', values });
		}
		if (subject.length > 200) {
			return fail(400, { error: 'Der Betreff ist zu lang (max. 200 Zeichen).', values });
		}
		if (!message || message.length < 10 || message.length > 5000) {
			return fail(400, {
				error: 'Die Nachricht muss zwischen 10 und 5000 Zeichen lang sein.',
				values
			});
		}

		const ip = getClientAddress();
		const ipHash = createHash('sha256').update(ip).digest('hex').slice(0, 32);

		const turnstileToken = String(form.get('cf-turnstile-response') ?? '');
		if (!(await verifyTurnstile(turnstileToken, ip))) {
			return fail(400, { error: 'Captcha-Prüfung fehlgeschlagen. Bitte erneut versuchen.', values });
		}

		if (isRateLimited(ipHash)) {
			return fail(429, {
				error: 'Zu viele Anfragen. Bitte versuche es später erneut.',
				values
			});
		}

		const userAgent = request.headers.get('user-agent')?.slice(0, 500) ?? null;

		sqlite
			.prepare(
				'INSERT INTO contact_messages (name, email, subject, message, ip_hash, user_agent) VALUES (?, ?, ?, ?, ?, ?)'
			)
			.run(name, email, subject || null, message, ipHash, userAgent);

		return { success: true, values: { name: '', email: '', subject: '', message: '' } };
	}
};
