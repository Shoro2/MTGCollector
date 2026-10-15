import { sqlite } from '$lib/server/db';
import { error } from '@sveltejs/kit';
import { cardSlugIndex } from '$lib/server/card-slugs';
import { pickMainPrinting, type PrintingSummary } from '$lib/card-page';

const CARD_COLUMNS = `id, oracle_id, name, mana_cost, cmc, type_line, oracle_text, colors, color_identity,
	set_code, set_name, collector_number, rarity, power, toughness, loyalty, image_uri, local_image_path,
	layout, legalities`;

/** One page per card: rules from a representative printing, every printing with its prices. */
export async function load({ params }) {
	const oracleId = cardSlugIndex(sqlite).bySlug.get(params.slug);
	if (!oracleId) throw error(404, 'Card not found');

	const printings = sqlite.prepare(`
		SELECT id, set_code, set_name, collector_number, rarity, released_at, image_uri, local_image_path,
			price_eur, price_usd, price_eur_foil, price_usd_foil
		FROM cards
		WHERE oracle_id = ? AND COALESCE(layout, '') != 'art_series'
		ORDER BY released_at DESC, set_name, collector_number
	`).all(oracleId) as PrintingSummary[];
	if (printings.length === 0) throw error(404, 'Card not found');

	const main = pickMainPrinting(printings);
	const card = sqlite.prepare(`SELECT ${CARD_COLUMNS} FROM cards WHERE id = ?`).get(main.id) as Record<string, unknown>;
	const faces = sqlite
		.prepare('SELECT name, mana_cost, type_line, oracle_text, image_uri, power, toughness FROM card_faces WHERE card_id = ? ORDER BY face_index')
		.all(main.id) as Array<Record<string, unknown>>;
	// Names printed on non-English printings (`npm run import-names`), e.g. German "Kriegshorn".
	const printedNames = sqlite
		.prepare('SELECT lang, printed_name FROM card_names WHERE name = ? AND printed_name != name ORDER BY lang, printed_name')
		.all(card.name) as Array<{ lang: string; printed_name: string }>;

	return { slug: params.slug, card, faces, printings, printedNames };
}
