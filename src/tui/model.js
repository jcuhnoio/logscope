// TUI state that has nothing to do with the terminal: the line buffer,
// annotations, filtering, and the visible-row index the renderer walks.
//
// Everything here is O(new data) per update. A firehose appends to `lines`
// and, if a line passes the filter, pushes one entry onto `vis`; nothing is
// re-scanned until the filter itself changes. That is the whole reason the
// TUI exists — the browser paid layout cost per line, this pays an array push.

export const LEVELS = ["err", "wrn", "inf", "dbg"];
export const MAX_LINES = 100_000;

/**
 * Filter text → RegExp, or null for "no filter". Plain text matches literally
 * and case-insensitively; `/re/flags` is a regex (case-insensitive unless the
 * pattern says otherwise is not supported — logs are searched, not parsed).
 * Throws on a bad regex so the caller can show it.
 */
export function parseFilter(raw) {
	const s = String(raw ?? "").trim();
	if (!s) return null;
	const m = s.match(/^\/(.+)\/([a-z]*)$/);
	if (m) return new RegExp(m[1], m[2].includes("i") ? m[2] : m[2] + "i");
	return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

/**
 * One row in the scrollable log: a line, or an annotation drawn under the
 * line it is anchored to. Rows sort by (seq, line-before-annotation, t, id),
 * so the order is the same whichever transport delivered them first.
 */
function rowKey(r) {
	return r.type === "line" ? [r.seq, 0, 0, ""] : [r.seq, 1, r.data.t ?? 0, String(r.data.id)];
}
export function cmpRows(a, b) {
	const x = rowKey(a);
	const y = rowKey(b);
	for (let i = 0; i < 4; i++) {
		if (x[i] < y[i]) return -1;
		if (x[i] > y[i]) return 1;
	}
	return 0;
}

export class LogModel {
	constructor({ maxLines = MAX_LINES } = {}) {
		this.maxLines = maxLines;
		this.lines = []; // line rows, seq-ascending
		this.anns = []; // every annotation, (seq, t)-ascending — the side list
		this.annById = new Map();
		this.vis = []; // visible rows (lines + annotations) in display order
		this.lastSeq = 0; // highest line seq seen — the stream resume cursor
		this.floor = 0; // seqs at or below this were evicted from the buffer
		this.sources = []; // names, first-seen order
		this.lvlOff = new Set();
		this.srcOff = new Set();
		this.filterRaw = "";
		this.filterRe = null;
		this.filterErr = null;
		this.visLines = 0;
		this.version = 0; // bumped on every change; the renderer redraws on mismatch
	}

	// ---- ingest ----------------------------------------------------------

	addLine(l) {
		if (!l || typeof l.seq !== "number") return false;
		if (l.seq <= this.lastSeq) return false; // replay after reconnect
		this.lastSeq = l.seq;
		if (l.src && !this.sources.includes(l.src)) this.sources.push(l.src);
		const row = { type: "line", seq: l.seq, data: l };
		this.lines.push(row);
		if (this.lineVisible(l)) {
			// Annotations can precede their line (anchored at the head as it
			// was when they were made), so a line is not always the last row.
			this.#insertVis(row);
			this.visLines++;
		}
		// Evict in chunks: a splice off the front of a 100k array is a memmove,
		// and doing one per line would cost more than everything else here.
		if (this.lines.length > this.maxLines + this.#slack()) this.#evict(this.lines.length - this.maxLines);
		this.version++;
		return true;
	}

	/** Insert or update. Returns "new", "updated", or null for a no-op duplicate. */
	addAnnotation(a) {
		if (!a || a.id == null) return null;
		const cur = this.annById.get(a.id);
		if (cur) {
			// Same record re-delivered (backlog + stream overlap) vs. an
			// in-place rewrite (flash progress): only `edited` tells them apart.
			if ((a.edited ?? 0) <= (cur.data.edited ?? 0)) return null;
			cur.data = a;
			this.#refreshAnnVisibility(cur);
			this.version++;
			return "updated";
		}
		const row = { type: "ann", seq: typeof a.seq === "number" ? a.seq : this.lastSeq, data: a };
		this.annById.set(a.id, row);
		this.anns.splice(upperBound(this.anns, row, cmpRows), 0, row);
		if (this.annVisible(row)) this.#insertVis(row);
		this.version++;
		return "new";
	}

	#slack() {
		return Math.max(1, Math.floor(this.maxLines / 10));
	}

	#insertVis(row) {
		const v = this.vis;
		if (!v.length || cmpRows(v[v.length - 1], row) <= 0) v.push(row);
		else v.splice(upperBound(v, row, cmpRows), 0, row);
	}

	#refreshAnnVisibility(row) {
		const want = this.annVisible(row);
		// The sort key (seq, t, id) never changes on update, so the row is
		// exactly where a binary search says it would be.
		const j = upperBound(this.vis, row, cmpRows) - 1;
		const i = j >= 0 && this.vis[j] === row ? j : -1;
		if (want && i < 0) this.#insertVis(row);
		else if (!want && i >= 0) this.vis.splice(i, 1);
	}

	#evict(n) {
		const gone = this.lines.splice(0, n);
		this.floor = gone[gone.length - 1].seq;
		// Visible rows are seq-ordered, so everything evicted sits at the front.
		// Annotations anchored there go too (they stay in the side list).
		let k = 0;
		while (k < this.vis.length && this.vis[k].seq <= this.floor) {
			if (this.vis[k].type === "line") this.visLines--;
			k++;
		}
		if (k) this.vis.splice(0, k);
		this.onEvict?.(k);
	}

	// ---- filtering -------------------------------------------------------

	lineVisible(l) {
		if (l.lvl && this.lvlOff.has(l.lvl)) return false;
		if (l.src && this.srcOff.has(l.src)) return false;
		if (this.filterRe && !this.filterRe.test(l.raw ?? "")) return false;
		return true;
	}

	annVisible(row) {
		// Annotations below the buffer floor have no line to sit beside.
		if (row.seq <= this.floor && this.floor > 0) return false;
		// Level/source toggles never hide analysis; only the text filter does.
		if (!this.filterRe) return true;
		const a = row.data;
		return this.filterRe.test(`${a.kind} ${a.author} ${a.text ?? ""} ${a.meta ? JSON.stringify(a.meta) : ""}`);
	}

	setFilter(raw) {
		this.filterRaw = raw;
		try {
			this.filterRe = parseFilter(raw);
			this.filterErr = null;
		} catch (err) {
			// Keep the last good filter on screen while the regex is mid-typing.
			this.filterErr = err.message;
			return;
		}
		this.rebuild();
	}

	toggleLevel(lvl) {
		if (this.lvlOff.has(lvl)) this.lvlOff.delete(lvl);
		else this.lvlOff.add(lvl);
		this.rebuild();
	}

	toggleSource(src) {
		if (this.srcOff.has(src)) this.srcOff.delete(src);
		else this.srcOff.add(src);
		this.rebuild();
	}

	/** Full re-scan: only on a filter change, never per incoming line. */
	rebuild() {
		const out = [];
		let n = 0;
		let ai = 0;
		const anns = this.anns;
		const pushAnnsUpTo = (row) => {
			while (ai < anns.length && (!row || cmpRows(anns[ai], row) < 0)) {
				if (this.annVisible(anns[ai])) out.push(anns[ai]);
				ai++;
			}
		};
		for (const row of this.lines) {
			pushAnnsUpTo(row);
			if (this.lineVisible(row.data)) {
				out.push(row);
				n++;
			}
		}
		pushAnnsUpTo(null);
		this.vis = out;
		this.visLines = n;
		this.version++;
	}

	/** Index in `vis` of the first row at or after `seq` (clamped). */
	indexOfSeq(seq) {
		let lo = 0;
		let hi = this.vis.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.vis[mid].seq < seq) lo = mid + 1;
			else hi = mid;
		}
		return Math.min(lo, this.vis.length - 1);
	}

	/**
	 * Where `row` is, or would be, in `vis`: the index of the last visible row
	 * sorting at or before it. The scroll anchor is a row, not an index, so
	 * inserts, evictions and filter changes never make the view jump.
	 */
	indexAtOrBefore(row) {
		return Math.max(0, upperBound(this.vis, row, cmpRows) - 1);
	}

	/** Drop everything on screen; history stays on the daemon. */
	clear() {
		if (!this.lines.length) return;
		this.#evict(this.lines.length);
		this.version++;
	}
}

/** First index i where arr[i] sorts strictly after x. */
function upperBound(arr, x, cmp) {
	let lo = 0;
	let hi = arr.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (cmp(arr[mid], x) <= 0) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}
