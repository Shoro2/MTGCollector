/**
 * Text that users write for others to read (deck names and descriptions). Pure, so the
 * rules are unit-tested and the same on every write path.
 *
 * Nobody moderates by hand, so the rules take away what spam needs: a way to reach the
 * spammer. Links, web addresses, e-mail addresses and invite links are refused when the
 * text is saved; invisible and control characters are removed.
 */

// Zero-width characters, bidirectional overrides, word joiners and the byte order mark:
// invisible, and used to hide words from filters or to reverse how text is displayed.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g;
// Control characters other than tab and line feed.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** Removes invisible and control characters, normalises line breaks and trims. */
export function cleanUserText(text: string, multiline = true): string {
	const cleaned = text.replace(/\r\n?/g, '\n').replace(INVISIBLE, '').replace(CONTROL, '');
	if (!multiline) return cleaned.replace(/\s+/g, ' ').trim();
	// At most two empty lines in a row; trailing spaces go.
	return cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

// Top-level domains spam uses, written in lower case. Upper case is left alone on purpose:
// "my deck.It wins" (a missing space) must not count as a link to deck.it.
const TLDS = [
	'com', 'net', 'org', 'info', 'biz', 'io', 'gg', 'me', 'co', 'tv', 'cc', 'to', 'ws', 'ly', 'app', 'dev', 'xyz', 'top', 'site', 'online',
	'shop', 'store', 'club', 'link', 'live', 'pro', 'vip', 'win', 'bet', 'casino', 'tk', 'ml', 'ga', 'cf', 'gq', 'ru', 'su', 'cn', 'in', 'us',
	'uk', 'eu', 'de', 'at', 'ch', 'fr', 'it', 'es', 'nl', 'be', 'pl', 'se', 'dk', 'no', 'fi', 'pt', 'br', 'ca', 'au', 'jp'
].join('|');
const STRONG = ['com', 'net', 'org', 'info', 'biz', 'io', 'gg', 'xyz', 'top', 'site', 'online', 'shop', 'store', 'link', 'ru'].join('|');

const CONTACT: RegExp[] = [
	// A scheme or "www." anywhere.
	/\b(?:https?|ftp):\/\//i,
	/\bwww\s*\.\s*\S/i,
	// name.tld and name.name.tld.
	new RegExp(`(?:^|[^\\w.@-])[A-Za-z0-9][A-Za-z0-9-]*(?:\\.[A-Za-z0-9-]+)*\\.(?:${TLDS})(?![A-Za-z0-9])`),
	// "shop . com", "shop .com", "shop. com": a space next to the dot is normal after a
	// sentence ("the end. it was"), so only the domains nobody starts a sentence with.
	new RegExp(`[A-Za-z0-9](?:\\s+\\.\\s*|\\.\\s+)(?:${STRONG})(?![A-Za-z0-9])`),
	// "shop dot com", "shop (dot) com", "shop [dot] com".
	new RegExp(`[A-Za-z0-9-]\\s*[([{]?\\s*\\bdot\\b\\s*[)\\]}]?\\s*(?:${STRONG})(?![A-Za-z0-9])`, 'i'),
	// E-mail addresses, also "name (at) host".
	/[A-Za-z0-9._%+-]+\s*(?:@|[([{]\s*at\s*[)\]}])\s*[A-Za-z0-9-]+\s*(?:\.|[([{]?\s*dot\s*[)\]}]?)\s*[A-Za-z]{2,}/i,
	// Invite and shortener hosts with a one-letter name the domain rule does not cover.
	/\b(?:t|wa)\s*\.\s*me\s*\//i,
	/\bdiscord(?:app)?\s*\.\s*(?:gg|com\s*\/\s*invite)\b/i
];

export const CONTACT_MESSAGE = 'Links, web addresses and e-mail addresses are not allowed in deck names and descriptions.';

/** True when the text holds a link, a web or e-mail address or an invite link. */
export function hasContact(text: string): boolean {
	const plain = text.replace(INVISIBLE, '');
	return CONTACT.some((pattern) => pattern.test(plain));
}
