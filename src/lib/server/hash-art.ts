/**
 * CLI for the art-hash index. Run from the repository root:
 *   npm run hash-art                       # hash every pending printing and back face (resumable)
 *   npm run hash-art -- --limit 500        # a slice
 *   npm run hash-art -- --retry-failed     # include rows whose image failed before
 *   npm run hash-art -- --sets mid,vow     # only these sets (a new set on release, or what a measurement needs first)
 *   npm run hash-art -- --status           # counts only
 *   npm run hash-art -- --export hashes.json / --import hashes.json   # move hashes between databases
 * MTG_DB_PATH selects the database like everywhere else.
 */
import { initDb } from './db.js';
import { artHashStatus, exportArtHashes, importArtHashes, runArtHashJob, DEFAULT_DELAY_MS } from './art-hash.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const log = (line: string) => console.log(`[art-hash] ${new Date().toISOString()} ${line}`);

initDb();

async function main() {
	const exportPath = value('--export');
	const importPath = value('--import');
	if (importPath) {
		const r = importArtHashes(importPath);
		log(`imported ${r.cards} card hashes and ${r.faces} face hashes from ${importPath}`);
	} else if (exportPath) {
		const r = exportArtHashes(exportPath);
		log(`exported ${r.cards} card hashes and ${r.faces} face hashes to ${exportPath}`);
	} else if (!flag('--status')) {
		const result = await runArtHashJob({
			limit: Number(value('--limit') ?? 0) || 0,
			delayMs: Number(value('--delay') ?? DEFAULT_DELAY_MS) || DEFAULT_DELAY_MS,
			retryFailed: flag('--retry-failed'),
			skipFaces: flag('--skip-faces'),
			sets: (value('--sets') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
			log
		});
		log(`run finished: ${result.hashed} hashed, ${result.failed} failed of ${result.total}`);
	}
	const s = artHashStatus();
	log(`status: ${s.hashed} cards hashed, ${s.failed} failed, ${s.pending} pending, ${s.faces} back faces hashed`);
}

main().catch((err) => {
	console.error('[art-hash] fatal:', err);
	process.exit(1);
});
