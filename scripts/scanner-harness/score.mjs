// Scoring of one photo's accepted cards against its expected instances (see harness.mjs).
/** "Innistrad: Midnight Hunt (MID) #10" -> { set: "mid", number: "10" } */
function parsePrinting(text) {
	const m = /\(([A-Za-z0-9]+)\)\s*#(\S+)\s*$/.exec(text ?? '');
	return m ? { set: m[1].toLowerCase(), number: m[2] } : null;
}

/** Score the accepted cards of one photo against its expected instances. */
export function scorePhoto(cards, expected) {
	const pool = expected.map((e) => (typeof e === 'string' ? { name: e } : { ...e, set: e.set?.toLowerCase() }));
	const m = { detected: cards.length, identity: 0, printing: 0, unresolvedPrinting: 0, wrongIdentity: 0, wrongPrinting: 0, missing: 0, extra: Math.max(0, cards.length - pool.length), likely: 0 };
	const wrong = [];
	for (const c of cards) {
		if (c.state === 'likely') { m.likely++; continue; }
		if (!c.name) continue;
		const p = parsePrinting(c.printing);
		const unique = c.candidates <= 1;
		// Prefer an expected instance with the same printing, then the same name.
		let i = unique && p ? pool.findIndex((e) => e.name === c.name && e.set === p.set && String(e.number) === p.number) : -1;
		const exactPrinting = i >= 0;
		if (i < 0) i = pool.findIndex((e) => e.name === c.name);
		if (i < 0) { m.wrongIdentity++; wrong.push(`${c.name} (${c.printing || 'no printing'})`); continue; }
		const e = pool.splice(i, 1)[0];
		m.identity++;
		if (!e.set) continue; // name-only expectation: printing not assessable
		if (!unique) m.unresolvedPrinting++;
		else if (exactPrinting) m.printing++;
		else { m.wrongPrinting++; wrong.push(`${c.name}: ${p ? p.set.toUpperCase() + ' #' + p.number : '?'} instead of ${e.set.toUpperCase()} #${e.number}`); }
	}
	m.missing = pool.length;
	return { metrics: m, wrong, missing: pool.map((e) => (e.set ? `${e.name} (${e.set.toUpperCase()} #${e.number})` : e.name)) };
}
