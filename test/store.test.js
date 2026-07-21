import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";

function mkStore(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logscope-test-"));
	const store = new Store(dir);
	t.after(async () => {
		await store.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return store;
}

test("addLine assigns monotonic seqs and defaults", (t) => {
	const s = mkStore(t);
	const a = s.addLine({ src: "dev", raw: "one" });
	const b = s.addLine({ src: "dev", raw: "two", lvl: "err", tag: "x" });
	assert.equal(a.seq, 1);
	assert.equal(b.seq, 2);
	assert.equal(a.msg, "one"); // msg defaults to raw
	assert.equal(a.lvl, null);
	assert.equal(s.head, 2);
});

test("memSlice is from-exclusive, to-inclusive", (t) => {
	const s = mkStore(t);
	for (let i = 1; i <= 5; i++) s.addLine({ src: "dev", raw: `l${i}` });
	assert.deepEqual(s.memSlice(2, 4).map((l) => l.raw), ["l3", "l4"]);
	assert.deepEqual(s.memSlice(0, null).map((l) => l.seq), [1, 2, 3, 4, 5]);
	assert.deepEqual(s.memSlice(5, 99), []);
});

test("query filters by src, level, tag, grep and honours order/limit", async (t) => {
	const s = mkStore(t);
	s.addLine({ src: "a", raw: "boot ok", lvl: "inf", tag: "sys" });
	s.addLine({ src: "b", raw: "socket 3 closed", lvl: "err", tag: "net" });
	s.addLine({ src: "a", raw: "socket 9 closed", lvl: "err", tag: "net" });
	s.addLine({ src: "a", raw: "done", lvl: "inf", tag: "sys" });

	const errs = await s.query({ level: "err" });
	assert.deepEqual(errs.lines.map((l) => l.seq), [2, 3]);

	const srcA = await s.query({ src: "a", grep: "socket \\d+" });
	assert.deepEqual(srcA.lines.map((l) => l.seq), [3]);

	const last2 = await s.query({ limit: 2, order: "desc" });
	assert.deepEqual(last2.lines.map((l) => l.seq), [4, 3]); // newest first
	assert.equal(last2.truncated, true);
});

test("an annotation made before any line (seq 0) is still delivered from the top", (t) => {
	const s = mkStore(t);
	s.addAnnotation({ kind: "mark", text: "session start" }); // head is 0
	assert.equal(s.annotationsIn(0).length, 1);
	assert.equal(s.annotationsIn(0, 5).length, 1);
	assert.equal(s.annotationsIn(1).length, 0); // cursor past it: excluded
});

test("annotations anchor to head by default and filter by range", (t) => {
	const s = mkStore(t);
	s.addLine({ src: "d", raw: "x" });
	const a1 = s.addAnnotation({ kind: "note", text: "at head" });
	assert.equal(a1.seq, 1);
	s.addLine({ src: "d", raw: "y" });
	s.addAnnotation({ kind: "mark", text: "later", seq: 2 });
	assert.equal(s.annotationsIn(0).length, 2);
	assert.deepEqual(s.annotationsIn(1).map((a) => a.text), ["later"]);
});

test("summary counts levels/tags and dedupes notable error shapes", (t) => {
	const s = mkStore(t);
	s.addLine({ src: "d", raw: "retry 1 at 0xA0", lvl: "err", tag: "net", msg: "retry 1 at 0xA0" });
	s.addLine({ src: "d", raw: "retry 2 at 0xB4", lvl: "err", tag: "net", msg: "retry 2 at 0xB4" });
	s.addLine({ src: "d", raw: "hello", lvl: "inf", tag: "sys", msg: "hello" });
	const sum = s.summary({ since: 0 });
	assert.equal(sum.count, 3);
	assert.equal(sum.byLevel.err, 2);
	assert.equal(sum.byTag.net, 2);
	assert.equal(sum.notable.length, 1); // same shape → one entry
	assert.equal(sum.notable[0].count, 2);
});

test("wait resolves on an already-buffered match (the race the cursor exists for)", async (t) => {
	const s = mkStore(t);
	s.addLine({ src: "d", raw: "BootNotification Accepted" });
	const r = await s.wait({ re: /Accepted/, since: 0, timeout: 1000, settle: 0 });
	assert.equal(r.timedOut, false);
	assert.equal(r.matched.seq, 1);
});

test("wait resolves on a future line with context", async (t) => {
	const s = mkStore(t);
	s.addLine({ src: "d", raw: "before" });
	const p = s.wait({ re: /target/, since: s.head, timeout: 2000, context: 1, settle: 0 });
	s.addLine({ src: "d", raw: "target hit" });
	s.addLine({ src: "d", raw: "after" });
	const r = await p;
	assert.equal(r.matched.raw, "target hit");
	assert.deepEqual(r.before.map((l) => l.raw), ["before"]);
});

test("wait respects src filter and times out cleanly", async (t) => {
	const s = mkStore(t);
	const p = s.wait({ re: /x/, src: "other", since: 0, timeout: 150, settle: 0 });
	s.addLine({ src: "d", raw: "x" }); // wrong src — must not satisfy the wait
	const r = await p;
	assert.equal(r.timedOut, true);
	assert.equal(r.cursor, s.head);
});

test("lines persist as JSONL on disk", (t) => {
	const s = mkStore(t);
	s.addLine({ src: "d", raw: "persisted" });
	// createWriteStream is async; give it a beat
	return new Promise((resolve) => {
		setTimeout(() => {
			const txt = fs.readFileSync(path.join(s.dir, "lines.jsonl"), "utf8");
			const rec = JSON.parse(txt.trim());
			assert.equal(rec.raw, "persisted");
			assert.equal(rec.seq, 1);
			resolve();
		}, 100);
	});
});

test("subscribe fans out and unsubscribes", (t) => {
	const s = mkStore(t);
	const got = [];
	const off = s.subscribe((ev, rec) => got.push([ev, rec.raw ?? rec.text]));
	s.addLine({ src: "d", raw: "a" });
	s.addAnnotation({ text: "n" });
	off();
	s.addLine({ src: "d", raw: "b" });
	assert.deepEqual(got, [["line", "a"], ["annotation", "n"]]);
});
