import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// Pure-function unit tests for the scanner library and the shared
		// formatting helpers. Run on the Node environment with no SvelteKit/Vite
		// plugins so the suite stays fast and fully offline — independent of
		// $app/$env and the SQLite layer. Server modules (src/lib/server) are not
		// covered here; DB-backed search is validated against a real DB.
		environment: 'node',
		include: ['src/lib/**/*.test.ts']
	}
});
