import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function load() {
	const content = readFileSync(join(process.cwd(), 'datenschutz-vorlage.txt'), 'utf-8');
	return { content };
}
