import { Google } from 'arctic';
import { randomBytes } from 'node:crypto';
import { sqlite } from './db.js';
import { env } from '$env/dynamic/private';

export type SessionUser = {
	id: string;
	name: string;
	email: string;
	avatarUrl: string | null;
	isAdmin: boolean;
	hasVisionApiKey: boolean;
};

export function getGoogleClient() {
	return new Google(
		env.GOOGLE_CLIENT_ID || '',
		env.GOOGLE_CLIENT_SECRET || '',
		env.ORIGIN + '/auth/callback/google'
	);
}

export function createSession(userId: string): string {
	const id = randomBytes(32).toString('hex');
	const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
	sqlite.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, expiresAt);
	return id;
}

// In-process session cache: every request runs validateSession(), which used
// to issue a DB query per request. 5 min TTL caps staleness for admin/email
// changes while still absorbing ~99% of lookups for active users.
const SESSION_TTL_MS = 5 * 60 * 1000;
const sessionCache = new Map<string, { user: SessionUser; at: number }>();
// Bound the cache so abusive clients can't inflate it.
const SESSION_CACHE_MAX = 5000;

function cacheSweep() {
	if (sessionCache.size <= SESSION_CACHE_MAX) return;
	const cutoff = Date.now() - SESSION_TTL_MS;
	for (const [key, val] of sessionCache) {
		if (val.at < cutoff) sessionCache.delete(key);
		if (sessionCache.size <= SESSION_CACHE_MAX) break;
	}
	// If still too large, drop arbitrary oldest.
	while (sessionCache.size > SESSION_CACHE_MAX) {
		const first = sessionCache.keys().next().value;
		if (first === undefined) break;
		sessionCache.delete(first);
	}
}

export function validateSession(sessionId: string): SessionUser | null {
	const cached = sessionCache.get(sessionId);
	if (cached && Date.now() - cached.at < SESSION_TTL_MS) {
		return cached.user;
	}

	const row = sqlite.prepare(
		`SELECT u.id, u.name, u.email, u.avatar_url, u.google_vision_api_key
		 FROM sessions s JOIN users u ON s.user_id = u.id
		 WHERE s.id = ? AND s.expires_at > ?`
	).get(sessionId, new Date().toISOString()) as { id: string; name: string; email: string; avatar_url: string | null; google_vision_api_key: string | null } | undefined;

	if (!row) {
		sessionCache.delete(sessionId);
		return null;
	}
	const adminEmail = env.ADMIN_EMAIL?.toLowerCase();
	const user: SessionUser = {
		id: row.id,
		name: row.name,
		email: row.email,
		avatarUrl: row.avatar_url,
		isAdmin: !!adminEmail && row.email.toLowerCase() === adminEmail,
		hasVisionApiKey: !!row.google_vision_api_key
	};
	sessionCache.set(sessionId, { user, at: Date.now() });
	cacheSweep();
	return user;
}

export function deleteSession(sessionId: string) {
	sqlite.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
	sessionCache.delete(sessionId);
}

export function invalidateSessionCache(sessionId?: string) {
	if (sessionId) sessionCache.delete(sessionId);
	else sessionCache.clear();
}

export function invalidateSessionCacheForUser(userId: string) {
	for (const [sid, entry] of sessionCache) {
		if (entry.user.id === userId) sessionCache.delete(sid);
	}
}

export function findOrCreateUser(googleId: string, email: string, name: string, avatarUrl: string | null): string {
	const existing = sqlite.prepare('SELECT id FROM users WHERE google_id = ?').get(googleId) as { id: string } | undefined;
	if (existing) {
		sqlite.prepare('UPDATE users SET email = ?, name = ?, avatar_url = ? WHERE id = ?').run(email, name, avatarUrl, existing.id);
		return existing.id;
	}

	const id = crypto.randomUUID();
	sqlite.prepare('INSERT INTO users (id, google_id, email, name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?)')
		.run(id, googleId, email, name, avatarUrl, new Date().toISOString());
	return id;
}
