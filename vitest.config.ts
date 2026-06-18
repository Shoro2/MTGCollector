import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// Pure-function unit tests for the scanner library. Run on the Node
		// environment with no SvelteKit/Vite plugins so the suite stays fast and
		// fully offline — independent of $app/$env and the SQLite layer. DB-backed
		// search (card-search.ts) is validated separately against a real DB.
		environment: 'node',
		include: ['src/lib/scanner/**/*.test.ts']
	}
});
