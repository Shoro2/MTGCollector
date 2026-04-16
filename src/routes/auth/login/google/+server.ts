import { redirect } from '@sveltejs/kit';
import { getGoogleClient } from '$lib/server/auth';
import { generateState, generateCodeVerifier } from 'arctic';
import { dev } from '$app/environment';

export async function GET({ cookies }) {
	const google = getGoogleClient();
	const state = generateState();
	const codeVerifier = generateCodeVerifier();

	const url = google.createAuthorizationURL(state, codeVerifier, ['openid', 'email', 'profile']);

	const baseOpts = { path: '/', httpOnly: true, maxAge: 600, sameSite: 'lax' as const, secure: !dev };
	cookies.set('google_oauth_state', state, baseOpts);
	cookies.set('google_code_verifier', codeVerifier, baseOpts);

	throw redirect(302, url.toString());
}
