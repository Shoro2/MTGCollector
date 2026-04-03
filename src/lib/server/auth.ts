import { Google } from 'arctic';
import { sqlite } from './db.js';
import { env } from '$env/dynamic/private';

export function getGoogleClient() {
	return new Google(
		env.GOOGLE_CLIENT_ID || '',
		env.GOOGLE_CLIENT_SECRET || '',
		env.ORIGIN + '/auth/callback/google'
	);
}

export function createSession(userId: string): string {
	const id = crypto.randomUUID();
	const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
	sqlite.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, expiresAt);
	return id;
}

export function validateSession(sessionId: string): { id: string; name: string; email: string; avatarUrl: string | null } | null {
	const row = sqlite.prepare(
		`SELECT u.id, u.name, u.email, u.avatar_url
		 FROM sessions s JOIN users u ON s.user_id = u.id
		 WHERE s.id = ? AND s.expires_at > ?`
	).get(sessionId, new Date().toISOString()) as { id: string; name: string; email: string; avatar_url: string | null } | undefined;

	if (!row) return null;
	return { id: row.id, name: row.name, email: row.email, avatarUrl: row.avatar_url };
}

export function deleteSession(sessionId: string) {
	sqlite.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function findOrCreateUser(googleId: string, email: string, name: string, avatarUrl: string | null): string {
	const existing = sqlite.prepare('SELECT id FROM users WHERE google_id = ?').get(googleId) as { id: string } | undefined;
	if (existing) {
		// Update profile info
		sqlite.prepare('UPDATE users SET email = ?, name = ?, avatar_url = ? WHERE id = ?').run(email, name, avatarUrl, existing.id);
		return existing.id;
	}

	const id = crypto.randomUUID();
	sqlite.prepare('INSERT INTO users (id, google_id, email, name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?)')
		.run(id, googleId, email, name, avatarUrl, new Date().toISOString());
	return id;
}
