/**
 * The app's Turnstile configuration from the environment (turnstile.ts holds the logic).
 * Server routes only: it reads $env, so unit tests import turnstile.ts instead.
 */
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { turnstileConfig, verifyTurnstile } from './turnstile';

const config = () => turnstileConfig({ ...env, PUBLIC_TURNSTILE_SITE_KEY: publicEnv.PUBLIC_TURNSTILE_SITE_KEY });

/** The site key for the browser widget, or null when the captcha is off. */
export const captchaSiteKey = () => config()?.siteKey ?? null;

/** True when the token passes (or the captcha is off). */
export const checkCaptcha = (token: unknown, ip: string | null, action: CaptchaAction) => verifyTurnstile(config(), token, ip, action);

/** The widget's action per form; the token must come back with the same one. */
export type CaptchaAction = 'contact' | 'publish-deck';
