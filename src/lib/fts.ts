/**
 * FTS5 prefix query for free text typed into the catalogue search.
 *
 * The cards_fts tokenizer (unicode61) splits words at apostrophes, so the index
 * holds "Teferi's Protection" as teferi / s / protection. Dropping the apostrophe
 * turned the query into "teferis"*, which matches nothing; splitting there like
 * the tokenizer does finds the card. Every term is quoted, so FTS5 operators and
 * column filters in the input stay plain text.
 */
export function ftsPrefixQuery(text: string): string {
	return text
		.split(/[\s'"\u2018\u2019\u201c\u201d`´]+/)
		.filter(Boolean)
		.map((term) => `"${term}"*`)
		.join(' ');
}
