// TUI logic that doesn't need a terminal: the model (buffer, filter, visible
// index), row formatting/layout, and the SSE parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LogModel, parseFilter } from "../src/tui/model.js";
import { layout, rowLines, strWidth, expandTabs, chunk, fmtClock } from "../src/tui/format.js";
import { sseParser } from "../src/tui/client.js";

let seq = 0;
const line = (over = {}) => ({ seq: ++seq, t: 1_700_000_000_000 + seq, src: "dev", raw: `line ${seq}`, lvl: "inf", tag: null, msg: `line ${seq}`, ...over });
const ann = (over = {}) => ({ id: `a-${++seq}`, seq: 0, t: 1_700_000_000_000 + seq, kind: "note", author: "claude", text: "hi", meta: {}, ...over });
const visDesc = (m) => m.vis.map((r) => (r.type === "line" ? `L${r.seq}` : `A${r.data.id}`));

test("parseFilter: plain text is literal and case-insensitive; /re/ is a regex", () => {
	assert.equal(parseFilter("  "), null);
	assert.ok(parseFilter("a.b").test("xA.Bx"));
	assert.ok(!parseFilter("a.b").test("axb"));
	assert.ok(parseFilter("/a.b/").test("AXB"));
	assert.throws(() => parseFilter("/(/"));
});

test("model: lines and annotations interleave by seq; replayed lines are dropped", () => {
	const m = new LogModel();
	const l1 = line();
	const l2 = line();
	m.addLine(l1);
	m.addLine(l2);
	const a = ann({ seq: l1.seq });
	m.addAnnotation(a);
	assert.equal(m.addLine(l1), false, "reconnect replay must not duplicate");
	assert.deepEqual(visDesc(m), [`L${l1.seq}`, `A${a.id}`, `L${l2.seq}`]);
});

test("model: annotation updates replace in place; plain re-delivery is a no-op", () => {
	const m = new LogModel();
	m.addLine(line());
	const a = ann({ seq: seq, text: "chunk 1/5" });
	assert.equal(m.addAnnotation(a), "new");
	assert.equal(m.addAnnotation({ ...a }), null);
	assert.equal(m.addAnnotation({ ...a, text: "chunk 2/5", edited: 5 }), "updated");
	assert.equal(m.vis.filter((r) => r.type === "ann").length, 1);
	assert.equal(m.anns[0].data.text, "chunk 2/5");
});

test("model: level/source toggles hide lines but never annotations; text filter hits both", () => {
	const m = new LogModel();
	m.addLine(line({ lvl: "err", raw: "boom" }));
	m.addLine(line({ lvl: "dbg", raw: "noise", src: "other" }));
	m.addAnnotation(ann({ seq, text: "about the noise" }));
	m.toggleLevel("dbg");
	assert.equal(m.visLines, 1);
	assert.equal(m.vis.filter((r) => r.type === "ann").length, 1);
	m.toggleLevel("dbg");
	m.toggleSource("other");
	assert.equal(m.visLines, 1);
	m.toggleSource("other");
	m.setFilter("noise");
	assert.deepEqual(m.vis.map((r) => r.type), ["line", "ann"]);
	m.setFilter("/(/");
	assert.ok(m.filterErr, "bad regex is reported");
	assert.equal(m.visLines, 1, "and the last good filter stays applied");
});

test("model: incremental vis matches a full rebuild after mixed ingest", () => {
	const m = new LogModel();
	m.setFilter("/[02468]$/");
	for (let i = 0; i < 50; i++) {
		m.addLine(line({ raw: `x ${i}` }));
		if (i % 7 === 0) m.addAnnotation(ann({ seq: seq - 3, text: `n ${i}0` }));
	}
	const inc = visDesc(m);
	m.rebuild();
	assert.deepEqual(inc, visDesc(m));
});

test("model: buffer evicts oldest lines in chunks, and their annotations leave the view", () => {
	const m = new LogModel({ maxLines: 10 });
	const first = line();
	m.addLine(first);
	m.addAnnotation(ann({ seq: first.seq }));
	for (let i = 0; i < 12; i++) m.addLine(line());
	assert.ok(m.lines.length >= 10 && m.lines.length <= 11, "within cap + 10% slack");
	assert.ok(m.floor >= first.seq);
	assert.ok(m.vis.every((r) => r.seq > m.floor));
	assert.equal(m.anns.length, 1, "the side list keeps it");
});

test("model: the scroll anchor survives inserts before it", () => {
	const m = new LogModel();
	for (let i = 0; i < 5; i++) m.addLine(line());
	const anchor = m.vis[2];
	m.addAnnotation(ann({ seq: m.vis[0].seq }));
	assert.equal(m.vis[m.indexAtOrBefore(anchor)], anchor);
});

test("format: display width counts Hangul/CJK as two cells; tabs expand to stops", () => {
	assert.equal(strWidth("ab한글"), 6);
	assert.equal(expandTabs("ab\tc"), "ab      c");
	assert.deepEqual(chunk("한글한글", 4), ["한글", "한글"]);
	assert.match(fmtClock(1_700_000_000_123), /^\d\d:\d\d:\d\d\.123$/);
});

const ctx = { width: 40, wrap: false, seqWidth: 5, srcWidth: 0 };
const text = (segs) => segs.map((s) => s.s).join("");

test("format: an empty send renders as ⏎, not a blank command", () => {
	const rows = rowLines({ type: "ann", seq: 1, data: ann({ kind: "command", author: "user", text: "→ ", meta: { port: "board", data: "" } }) }, ctx);
	assert.match(text(rows[1]), /→ board: ⏎/);
});

test("format: wrap mode splits long lines; layout fills a short view top-down", () => {
	const long = { type: "line", seq: 1, data: line({ raw: "x".repeat(100), msg: "x".repeat(100) }) };
	assert.equal(rowLines(long, ctx).length, 1);
	assert.ok(rowLines(long, { ...ctx, wrap: true }).length > 2);

	const rows = Array.from({ length: 5 }, () => ({ type: "line", seq: 0, data: line() }));
	const out = layout(rows, 1, 4, ctx);
	assert.equal(out.length, 4, "near the top, rows below the anchor fill the view");
	assert.equal(out[0].row, rows[0]);
});

test("sseParser: events split across chunks, CRLF, multi-line data", () => {
	const got = [];
	const feed = sseParser((e, d) => got.push([e, d]));
	feed("event: line\ndata: {\"a\":");
	feed("1}\r\n\r\nevent: ping\ndata: {}\n\ndata: x\ndata: y\n\n");
	assert.deepEqual(got, [["line", '{"a":1}'], ["ping", "{}"], ["message", "x\ny"]]);
});
