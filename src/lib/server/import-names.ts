/**
 * CLI for the printed names of non-English printings (the scanner's name
 * search for German, French … cards). Run from the repository root:
 *   npm run import-names                         # download Scryfall's all-cards bulk (~400 MB), import German names
 *   npm run import-names -- --langs de,fr,it     # other / more languages (each replaces its own rows)
 *   npm run import-names -- --status             # counts only
 *   npm run import-names -- --export names.json / --import names.json   # move the table between databases
 * Run it again after a set release. MTG_DB_PATH selects the database like everywhere else.
 */
import { initDb } from './db.js';
import { DEFAULT_LANGS, exportPrintedNames, importPrintedNames, importPrintedNamesFromScryfall, printedNamesStatus } from './printed-names.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const log = (line: string) => console.log(`[import-names] ${new Date().toISOString()} ${line}`);

initDb();

async function main() {
	const exportPath = value('--export');
	const importPath = value('--import');
	if (importPath) {
		const r = importPrintedNames(importPath);
		log(`imported ${r.rows} printed names from ${importPath}${r.skipped ? ` (${r.skipped} of cards not in the catalogue skipped)` : ''}`);
	} else if (exportPath) {
		const r = exportPrintedNames(exportPath);
		log(`exported ${r.rows} printed names to ${exportPath}`);
	} else if (!flag('--status')) {
		const langs = (value('--langs') ?? DEFAULT_LANGS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
		await importPrintedNamesFromScryfall({ langs, log });
	}
	const status = printedNamesStatus();
	log(`status: ${status.length === 0 ? 'no printed names' : status.map((s) => `${s.lang} ${s.rows} names of ${s.names} cards`).join(', ')}`);
}

main().catch((err) => {
	console.error('[import-names] fatal:', err);
	process.exit(1);
});
