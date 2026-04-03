import { redirect } from '@sveltejs/kit';
import { getGoogleClient } from '$lib/server/auth';
import { generateState, generateCodeVerifier } from 'arctic';

export async function GET({ cookies }) {
	const google = getGoogleClient();
	const state = generateState();
	const codeVerifier = generateCodeVerifier();

	const url = google.createAuthorizationURL(state, codeVerifier, ['openid', 'email', 'profile']);

	cookies.set('google_oauth_state', state, { path: '/', httpOnly: true, maxAge: 600, sameSite: 'lax' });
	cookies.set('google_code_verifier', codeVerifier, { path: '/', httpOnly: true, maxAge: 600, sameSite: 'lax' });

	throw redirect(302, url.toString());
}
