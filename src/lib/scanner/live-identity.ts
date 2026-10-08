import { liveArtHashes } from './warp';

export async function probeLiveIdentity(canvas: HTMLCanvasElement, corners: Array<[number, number]>, signal: AbortSignal): Promise<string | null> {
	const hashes = liveArtHashes(canvas, corners);
	const res = await fetch('/scan', {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
		body: JSON.stringify({ artHashes: [hashes], identityProbe: true })
	});
	if (!res.ok) throw new Error(`Artwork check: HTTP ${res.status}`);
	const data = await res.json();
	const identity = data?.batch?.[0]?.identity;
	return typeof identity === 'string' ? identity : null;
}
