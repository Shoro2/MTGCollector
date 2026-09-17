// Server-side secret for keyed hashes (hashIdentifier). The key is persisted to
// data/secret-key.hex and auto-generated on first use, so deployments don't have
// to configure a shared env var. The file used to double as the AES key for
// per-user Google Vision API keys; that feature, and the encryption helpers
// with it, were removed on 2026-09-17.

import { randomBytes, createHmac } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

const KEY_BYTES = 32;

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
	// failure here is a real risk — a world-readable key file would let anyone
	// recompute the keyed hashes.
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

/**
 * Keyed hash for pseudonymising short identifiers (IPs, etc.) before storage.
 * Uses HMAC-SHA256 with the server-side secret, so plain SHA-256
 * rainbow-table lookups don't work. The hash is
 * stable across calls on the same server instance but rotates if the key
 * file is regenerated.
 */
export function hashIdentifier(value: string, domain = 'default'): string {
	const key = loadOrCreateKey();
	return createHmac('sha256', key).update(`${domain}:${value}`).digest('hex').slice(0, 32);
}
