// Row → styled text. Pure: every function here returns plain data
// ([{ s, st }] segments, where `st` names a style in screen.js), so layout is
// testable without a terminal.

/**
 * Wallclock ms → local HH:MM:SS.mmm. Absolute time, not uptime: the usual
 * question is "what else was happening at 14:32?", and time-since-boot can't
 * answer it. Hand-padded so the column never changes width.
 */
export function fmtClock(t) {
	if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) return "--:--:--.---";
	const d = new Date(t);
	const p = (n, w = 2) => String(n).padStart(w, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// Distinguishable on both dark and light backgrounds, none of them red or
// yellow (those mean err/wrn in the level column right next to it).
const SRC_COLORS = [39, 75, 114, 141, 176, 80, 105, 149, 117, 183];

/** Stable 256-colour index per source name. */
export function srcColor(name) {
	let h = 0;
	const s = String(name ?? "");
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
	return SRC_COLORS[h % SRC_COLORS.length];
}

// ---- display width ---------------------------------------------------------

// East Asian wide/fullwidth ranges plus the emoji blocks. Device logs carry
// Hangul and CJK in practice; a column that assumes one cell per code point
// shears every row after the first such character.
const WIDE = [
	[0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
	[0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
	[0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f],
	[0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];

export function charWidth(cp) {
	if (cp < 0x1100) return 1;
	for (const [a, b] of WIDE) {
		if (cp < a) return 1;
		if (cp <= b) return 2;
	}
	return 1;
}

export function strWidth(s) {
	let w = 0;
	for (const ch of s) w += charWidth(ch.codePointAt(0));
	return w;
}

/** Expand tabs to 8-column stops, measured from the start of `s`. */
export function expandTabs(s) {
	if (!s.includes("\t")) return s;
	let out = "";
	let col = 0;
	for (const ch of s) {
		if (ch === "\t") {
			const n = 8 - (col % 8);
			out += " ".repeat(n);
			col += n;
		} else {
			out += ch;
			col += charWidth(ch.codePointAt(0));
		}
	}
	return out;
}

/** Cut `s` into pieces of at most `w` cells (hard wrap; logs have no words). */
export function chunk(s, w) {
	if (w <= 0) return [s];
	const out = [];
	let cur = "";
	let cw = 0;
	for (const ch of s) {
		const c = charWidth(ch.codePointAt(0));
		if (cw + c > w && cur) {
			out.push(cur);
			cur = "";
			cw = 0;
		}
		cur += ch;
		cw += c;
	}
	out.push(cur);
	return out;
}

// ---- rows ------------------------------------------------------------------

const LVL_STYLE = { err: "lvlErr", wrn: "lvlWrn", inf: "lvlInf", dbg: "lvlDbg" };
const MSG_STYLE = { err: "msgErr", wrn: "msgWrn", dbg: "msgDbg" };

/**
 * Who made an annotation. "Did I send that, or did the agent?" is the first
 * question when reading a session back.
 */
export function authorStyle(author) {
	const a = String(author ?? "").toLowerCase();
	if (a === "user") return "byUser";
	if (a === "system") return "bySystem";
	return "byAgent";
}

/**
 * The fixed-width prefix of a log line: time, seq, source, level, tag.
 * `ctx.srcWidth` is 0 when there is only one source (the column is noise).
 */
function linePrefix(l, ctx) {
	const segs = [
		{ s: fmtClock(l.t) + " ", st: "time" },
		{ s: String(l.seq).padStart(ctx.seqWidth) + " ", st: "seq" },
	];
	if (ctx.srcWidth) {
		const name = String(l.src ?? "").slice(0, ctx.srcWidth).padEnd(ctx.srcWidth);
		segs.push({ s: name + " ", st: { color: srcColor(l.src) } });
	}
	if (l.lvl != null || l.tag != null) {
		segs.push({ s: (l.lvl ?? "").padEnd(3) + " ", st: LVL_STYLE[l.lvl] ?? "lvlInf" });
		if (l.tag) segs.push({ s: l.tag + ": ", st: "tag" });
	}
	return segs;
}

function lineText(l) {
	const parsed = l.lvl != null || l.tag != null;
	return expandTabs(String((parsed ? l.msg : l.raw) ?? ""));
}

/** Screen lines for one log line: one row, or several in wrap mode. */
function lineRows(l, ctx) {
	const prefix = linePrefix(l, ctx);
	const msgSt = MSG_STYLE[l.lvl] ?? "msg";
	const text = lineText(l);
	if (!ctx.wrap) return [[...prefix, { s: text, st: msgSt }]];
	// Continuation rows indent under the time column, not under the message:
	// the message column can sit 40+ cells in, which leaves no room to wrap.
	const pw = prefix.reduce((n, p) => n + strWidth(p.s), 0);
	const indent = 4;
	const first = Math.max(8, ctx.width - pw);
	const firstChunk = chunk(text, first)[0];
	const rest = text.slice(firstChunk.length);
	const rows = [[...prefix, { s: firstChunk, st: msgSt }]];
	if (rest) {
		for (const c of chunk(rest, Math.max(8, ctx.width - indent))) {
			rows.push([{ s: " ".repeat(indent) }, { s: c, st: msgSt }]);
		}
	}
	return rows;
}

const KIND_STYLE = { analysis: "kAnalysis", note: "kNote", error: "kError", command: "kCommand", run: "kRun" };

/** Screen lines for one annotation. Annotations always wrap; they are prose. */
function annRows(a, ctx) {
	const meta = a.meta ?? {};
	const w = ctx.width;

	if (a.kind === "mark") {
		const label = ` ${meta.label || a.text || "mark"} `;
		const left = "──── ";
		const fill = Math.max(0, w - strWidth(left) - strWidth(label));
		return [[{ s: left + label + "─".repeat(fill), st: "mark" }]];
	}

	const gutter = { s: "  ▍ ", st: KIND_STYLE[a.kind] ?? "kNote" };
	const who = { s: `${a.kind} · ${a.author ?? "claude"} · ${fmtClock(a.t)}`, st: authorStyle(a.author) };

	if (a.kind === "run") {
		// The daemon records a run as two annotations — one at start, one with
		// the result — so the start row just names the command.
		const exit = meta.exit;
		const label = String(a.text || meta.cmd || "run").replace(/ → exit .*$/, "");
		const segs = [gutter, { s: label, st: "kRun" }];
		if (meta.state !== "running") {
			segs.push({ s: ` exit ${exit ?? "?"}${meta.ms != null ? ` (${meta.ms}ms)` : ""}`, st: exit === 0 ? "ok" : "bad" });
		}
		segs.push({ s: "  " }, { ...who, st: "dim" });
		return [segs];
	}

	let body = String(a.text ?? "");
	if (a.kind === "command" && meta.data != null) {
		// `→ ` + empty data is a bare newline sent to the device; say so, or
		// the row reads as an empty command.
		const data = meta.data === "" ? "⏎" : meta.data;
		body = `→ ${meta.port ? meta.port + ": " : ""}${data}`;
	}
	const rows = [[gutter, who]];
	const tw = Math.max(8, w - strWidth(gutter.s));
	for (const para of expandTabs(body).split("\n")) {
		for (const c of chunk(para, tw)) rows.push([gutter, { s: c, st: "annText" }]);
	}
	return rows;
}

export function rowLines(row, ctx) {
	return row.type === "line" ? lineRows(row.data, ctx) : annRows(row.data, ctx);
}

/**
 * Cached height of a row at the current width/wrap. Lines are 1 high unless
 * wrapping; annotations are measured once per (width, edit).
 */
export function rowHeight(row, ctx) {
	if (row.type === "line" && !ctx.wrap) return 1;
	const key = `${ctx.width}|${ctx.wrap ? 1 : 0}|${ctx.seqWidth}|${ctx.srcWidth}|${row.data.edited ?? 0}`;
	if (row._hk !== key) {
		row._hk = key;
		row._h = rowLines(row, ctx).length;
	}
	return row._h;
}

/**
 * The screen lines to draw, top to bottom, for a viewport whose last row is
 * vis[bottom]. Bottom-anchored because a log is read from the newest end:
 * follow mode is just "bottom = last row", and nothing needs total heights.
 */
export function layout(vis, bottom, height, ctx) {
	const out = [];
	for (let i = bottom; i >= 0 && out.length < height; i--) {
		const lines = rowLines(vis[i], ctx);
		for (let j = lines.length - 1; j >= 0 && out.length < height; j--) {
			out.push({ segs: lines[j], row: vis[i] });
		}
	}
	out.reverse();
	// Scrolled near the top: there is not a screenful above the anchor, so
	// fill downward instead of leaving the bottom of the pane blank.
	for (let i = bottom + 1; i < vis.length && out.length < height; i++) {
		for (const segs of rowLines(vis[i], ctx)) {
			if (out.length >= height) break;
			out.push({ segs, row: vis[i] });
		}
	}
	return out;
}
