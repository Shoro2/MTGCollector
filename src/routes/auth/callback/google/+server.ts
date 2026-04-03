import { redirect } from '@sveltejs/kit';
import { getGoogleClient, findOrCreateUser, createSession } from '$lib/server/auth';

export async function GET({ url, cookies }) {
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const storedState = cookies.get('google_oauth_state');
	const codeVerifier = cookies.get('google_code_verifier');

	if (!code || !state || !storedState || state !== storedState || !codeVerifier) {
		throw redirect(302, '/login?error=invalid_state');
	}

	const google = getGoogleClient();

	try {
		const tokens = await google.validateAuthorizationCode(code, codeVerifier);
		const accessToken = tokens.accessToken();

		// Fetch user info from Google
		const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
			headers: { Authorization: `Bearer ${accessToken}` }
		});
		const profile = await res.json();

		const userId = findOrCreateUser(
			profile.id,
			profile.email,
			profile.name,
			profile.picture || null
		);

		const sessionId = createSession(userId);

		cookies.set('session', sessionId, {
			path: '/',
			httpOnly: true,
			maxAge: 30 * 24 * 60 * 60, // 30 days
			sameSite: 'lax'
		});

		// Clean up OAuth cookies
		cookies.delete('google_oauth_state', { path: '/' });
		cookies.delete('google_code_verifier', { path: '/' });
	} catch (err) {
		console.error('Google OAuth error:', err);
		throw redirect(302, '/login?error=auth_failed');
	}

	throw redirect(302, '/');
}
