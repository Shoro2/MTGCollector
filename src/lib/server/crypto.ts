// AES-256-GCM helpers for encrypting user-supplied secrets (currently only
// Google Vision API keys) at rest. The key is persisted to data/secret-key.hex
// and auto-generated on first use so deployments don't have to configure a
// shared env var. Values older than the v1 scheme are treated as legacy
// plaintext and passed through unchanged — this keeps existing users working
// while `decryptSecret` opportunistically re-encrypts them on next write.

import { randomBytes, createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

const ALGO = 'aes-256-gcm';
const PREFIX = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12; // GCM recommended length

let cachedKey: Buffer | null = null;

function loadOrCreateKey(): Buffer {
	if (cachedKey) return cachedKey;

	const dataDir = join(process.cwd(), 'data');
	mkdirSync(dataDir, { recursive: true });
	const keyPath = join(dataDir, 'secret-key.hex');

	if (existsSync(keyPath)) {
		const hex = readFileSync(keyPath, 'utf-8').trim();
		if (hex.length === KEY_BYTES * 2) {
			cachedKey = Buffer.from(hex, 'hex');
			return cachedKey;
		}
		// Fall through and regenerate if the file is malformed.
		console.warn('[crypto] secret-key.hex malformed, regenerating');
	}

	const key = randomBytes(KEY_BYTES);
	writeFileSync(keyPath, key.toString('hex'), { encoding: 'utf-8' });
	// On POSIX filesystems, assert the key ended up with mode 0600. Silent
	// failure here is a real risk — a world-readable key file would expose
	// every user's Vision API key.
	if (platform() !== 'win32') {
		try {
			chmodSync(keyPath, 0o600);
			const mode = statSync(keyPath).mode & 0o777;
			if (mode !== 0o600) {
				console.warn(
					`[crypto] secret-key.hex has mode ${mode.toString(8)}, expected 600 — ` +
					`check filesystem permissions (data dir should not be group- or world-readable)`
				);
			}
		} catch (err) {
			console.error('[crypto] Failed to restrict secret-key.hex permissions:', err);
		}
	}
	cachedKey = key;
	return key;
}

export function encryptSecret(plaintext: string): string {
	const key = loadOrCreateKey();
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(ALGO, key, iv);
	const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return `${PREFIX}:${iv.toString('hex')}:${enc.toString('hex')}:${tag.toString('hex')}`;
}

/**
 * Decrypt a previously stored secret. Returns `null` on tamper / corrupt input.
 * Values that don't carry the v1 prefix are treated as legacy plaintext and
 * returned as-is (so existing Vision keys keep working until re-saved).
 */
export function decryptSecret(stored: string): string | null {
	if (!stored) return null;
	if (!stored.startsWith(`${PREFIX}:`)) {
		// Legacy plaintext from before encryption was introduced.
		return stored;
	}
	const parts = stored.split(':');
	if (parts.length !== 4) return null;
	const [, ivHex, encHex, tagHex] = parts;
	try {
		const key = loadOrCreateKey();
		const iv = Buffer.from(ivHex, 'hex');
		const enc = Buffer.from(encHex, 'hex');
		const tag = Buffer.from(tagHex, 'hex');
		const decipher = createDecipheriv(ALGO, key, iv);
		decipher.setAuthTag(tag);
		const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
		return dec.toString('utf-8');
	} catch {
		return null;
	}
}

/** True if the stored value was written by `encryptSecret`. */
export function isEncrypted(stored: string): boolean {
	return !!stored && stored.startsWith(`${PREFIX}:`);
}

/**
 * Keyed hash for pseudonymising short identifiers (IPs, etc.) before storage.
 * Uses HMAC-SHA256 with the same server-side secret that encrypts user
 * secrets, so plain SHA-256 rainbow-table lookups don't work. The hash is
 * stable across calls on the same server instance but rotates if the key
 * file is regenerated.
 */
export function hashIdentifier(value: string, domain = 'default'): string {
	const key = loadOrCreateKey();
	return createHmac('sha256', key).update(`${domain}:${value}`).digest('hex').slice(0, 32);
}
