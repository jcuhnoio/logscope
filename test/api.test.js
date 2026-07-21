// Integration: boot the real daemon on an ephemeral port with a file source
// and walk the HTTP contract end to end. No tty required.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";

async function boot(t, extraCfg = {}) {
	const proj = fs.mkdtempSync(path.join(os.tmpdir(), "logscope-api-"));
	const feed = path.join(proj, "feed.log");
	fs.writeFileSync(feed, "");
	fs.mkdirSync(path.join(proj, ".logscope"), { recursive: true });
	fs.writeFileSync(
		path.join(proj, ".logscope", "config.json"),
		JSON.stringify({
			sources: [{ name: "dev", type: "file", file: feed, from: "start" }],
			commands: { hello: "echo hi", fail: "exit 3" },
			...extraCfg,
		})
	);
	const s = await startServer({ projectDir: proj, port: 0 });
	const base = `http://127.0.0.1:${s.server.address().port}`;
	t.after(async () => {
		for (const src of s.sources.values()) src.stop();
		await s.store.close();
		s.server.close();
		fs.rmSync(proj, { recursive: true, force: true });
	});
	const api = async (p, body, method) => {
		const r = await fetch(base + p, {
			method: method ?? (body ? "POST" : "GET"),
			headers: body ? { "content-type": "application/json" } : undefined,
			body: body ? JSON.stringify(body) : undefined,
		});
		return { status: r.status, json: await r.json() };
	};
	return { proj, feed, api, s };
}

test("status → feed lines → wait → summary → grep", async (t) => {
	const { feed, api } = await boot(t);

	const st = await api("/api/status");
	assert.equal(st.status, 200);
	assert.equal(st.json.head, 0);
	assert.deepEqual(st.json.ports.map((p) => p.name), ["dev"]);
	assert.equal(st.json.ports[0].writable, false);

	// wait server-side while the file grows — the primary agent verb
	const waiting = api("/api/wait", { pattern: "Accepted", timeout: 5000 });
	fs.appendFileSync(feed, "<inf> sys: boot ok\n<err> net: socket 3 closed\nBootNotification Accepted\n");
	const w = await waiting;
	assert.equal(w.json.timedOut, false);
	assert.equal(w.json.matched.raw, "BootNotification Accepted");
	assert.equal(w.json.matched.seq, 3);

	const lines = await api("/api/lines?limit=10");
	assert.equal(lines.json.lines.length, 3);
	assert.equal(lines.json.lines[0].tag, "sys"); // parsed by default presets

	const sum = await api("/api/summary", { since: 0 });
	assert.equal(sum.json.count, 3);
	assert.equal(sum.json.byLevel.err, 1);

	const g = await api("/api/lines?grep=socket+%5Cd%2B&level=err");
	assert.equal(g.json.lines.length, 1);
	assert.equal(g.json.lines[0].seq, 2);
});

test("per-source parser config is honoured", async (t) => {
	const { feed, api } = await boot(t, {
		sources: undefined, // replaced below
	});
	// boot() already wrote config; write a fresh one exercising source parsers
	// (separate boot keeps this test independent)
	const { feed: feed2, api: api2 } = await boot(t, {
		parsers: ["uptime-level"],
	});
	fs.appendFileSync(feed2, "100:INFO:mod: hi\n<inf> zeph: ignored\n");
	const w = await api2("/api/wait", { pattern: "ignored", timeout: 5000 });
	assert.equal(w.json.timedOut, false);
	const lines = await api2("/api/lines?limit=10");
	assert.equal(lines.json.lines[0].tag, "mod");
	assert.equal(lines.json.lines[1].lvl, null); // zephyr preset disabled
	void feed;
	void api;
});

test("annotate, mark, and range query", async (t) => {
	const { api } = await boot(t);
	const a = await api("/api/annotate", { text: "hello", kind: "analysis", author: "user" });
	assert.equal(a.status, 200);
	assert.equal(a.json.kind, "analysis");
	const bad = await api("/api/annotate", { kind: "note" });
	assert.equal(bad.status, 400);
	await api("/api/mark", { label: "phase-1" });
	const anns = await api("/api/annotations");
	// the file source contributes a system "tailing…" mark at seq 0
	const ours = anns.json.annotations.filter((x) => x.author !== "system");
	assert.deepEqual(ours.map((x) => x.kind), ["analysis", "mark"]);
});

test("run: alias resolution, appended args, failure exit codes", async (t) => {
	const { api } = await boot(t);
	const ok = await api("/api/run", { cmd: "hello" });
	assert.equal(ok.json.exit, 0);
	assert.equal(ok.json.resolved, "echo hi");
	assert.equal(ok.json.stdout.trim(), "hi");

	const args = await api("/api/run", { cmd: "hello there" });
	assert.equal(args.json.resolved, "echo hi there");

	const fail = await api("/api/run", { cmd: "fail" });
	assert.equal(fail.json.exit, 3);

	const raw = await api("/api/run", { cmd: "printf raw-cmd" });
	assert.equal(raw.json.stdout, "raw-cmd"); // non-alias runs verbatim
});

test("flash refuses on a read-only source", async (t) => {
	const { api } = await boot(t);
	const r = await api("/api/flash", { file: "app.img" });
	assert.equal(r.status, 409);
	assert.match(r.json.error, /not a writable serial port/);
});

test("notes: read, replace, append, mtime advances", async (t) => {
	const { api } = await boot(t);
	const n0 = await api("/api/notes");
	assert.match(n0.json.markdown, /# logscope knowledge/); // seeded
	await api("/api/notes", { markdown: "# mine\n" }, "PUT");
	const n1 = await api("/api/notes");
	assert.equal(n1.json.markdown, "# mine\n");
	await api("/api/notes", { append: "- learned a thing" }, "PATCH");
	const n2 = await api("/api/notes");
	assert.match(n2.json.markdown, /- learned a thing\n$/);
	assert.ok(n2.json.mtime >= n1.json.mtime);
});

test("scripts dir is seeded with the contract README", async (t) => {
	const { proj } = await boot(t);
	const readme = fs.readFileSync(path.join(proj, ".logscope", "scripts", "README.md"), "utf8");
	assert.match(readme, /flash\.script|flash scripts/i);
});

test("unknown parser preset in config fails startup loudly", async (t) => {
	const proj = fs.mkdtempSync(path.join(os.tmpdir(), "logscope-bad-"));
	t.after(() => fs.rmSync(proj, { recursive: true, force: true }));
	fs.mkdirSync(path.join(proj, ".logscope"), { recursive: true });
	fs.writeFileSync(
		path.join(proj, ".logscope", "config.json"),
		JSON.stringify({
			sources: [{ name: "d", type: "file", file: path.join(proj, "x.log") }],
			parsers: ["zehpyr"],
		})
	);
	await assert.rejects(() => startServer({ projectDir: proj, port: 0 }), /unknown parser preset/);
});
