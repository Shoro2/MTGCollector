/**
 * Cloudflare Turnstile, the captcha on /contact and in front of publishing a deck. Pure
 * apart from the injected fetch: the configuration comes in as an object, so the unit
 * tests never need $env (see captcha.ts for the app's wrapper).
 *
 * Turnstile is on only when both keys are set: the site key renders the widget in the
 * browser, the secret verifies its token here. With one of them missing the widget is not
 * shown and every check passes, so a half-configured server never locks people out.
 */

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type TurnstileConfig = { siteKey: string; secret: string; verifyUrl: string };

export type TurnstileEnv = {
	PUBLIC_TURNSTILE_SITE_KEY?: string;
	TURNSTILE_SECRET_KEY?: string;
	/** Development only: a stand-in siteverify endpoint for the browser checks. */
	TURNSTILE_VERIFY_URL?: string;
};

export function turnstileConfig(env: TurnstileEnv): TurnstileConfig | null {
	const siteKey = env.PUBLIC_TURNSTILE_SITE_KEY?.trim();
	const secret = env.TURNSTILE_SECRET_KEY?.trim();
	if (!siteKey || !secret) return null;
	return { siteKey, secret, verifyUrl: env.TURNSTILE_VERIFY_URL?.trim() || SITEVERIFY_URL };
}

/**
 * Asks Cloudflare whether a widget token is valid. A token is good for one check only. With
 * `action`, the token must come from a widget rendered with that action, so a token solved
 * for the contact form cannot publish a deck. Network errors count as a failed check.
 */
export async function verifyTurnstile(
	config: TurnstileConfig | null,
	token: unknown,
	ip: string | null,
	action?: string,
	fetchImpl: typeof fetch = fetch
): Promise<boolean> {
	if (!config) return true;
	if (typeof token !== 'string' || !token || token.length > 2048) return false;
	try {
		const body = new URLSearchParams({ secret: config.secret, response: token });
		if (ip) body.set('remoteip', ip);
		const res = await fetchImpl(config.verifyUrl, { method: 'POST', body, signal: AbortSignal.timeout(10_000) });
		const data = (await res.json()) as { success?: boolean; action?: string };
		return data.success === true && (!action || data.action === action);
	} catch {
		return false;
	}
}
