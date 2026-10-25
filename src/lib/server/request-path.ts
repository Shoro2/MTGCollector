// Request paths that SvelteKit cannot decode. Before routing, SvelteKit decodes the
// path with decodeURI, split at '%25'. When that fails (malformed percent-encoding,
// such as the overlong UTF-8 in scanner probes like /%c0%ae%c0%ae/etc/passwd), it
// calls the handle hook outside its own error handling and answers 400 only if the
// hook returns normally. A redirect or error thrown by the hook then rejects the
// request promise unhandled, and Node exits: production went down that way on
// 2026-10-24. SvelteKit 2.70.3 and 3.1.0 both behave like this, so the hook answers
// such paths itself (src/hooks.server.ts).

/**
 * Whether SvelteKit can decode the path. decodeURI over the whole path fails on
 * exactly the paths where SvelteKit's split at '%25' fails, because '%25' is a
 * complete escape on its own and no multi-byte sequence can span it.
 */
export function isDecodablePath(pathname: string): boolean {
	try {
		decodeURI(pathname);
		return true;
	} catch {
		return false;
	}
}
