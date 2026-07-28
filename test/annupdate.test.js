// Annotation update-in-place: /api/annotate with an id rewrites instead of
// creating — the mechanism behind self-updating progress notes (XMODEM flash).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";

async function boot(t) {
	const proj = fs.mkdtempSync(path.join(os.tmpdir(), "logscope-annupd-"));
	fs.mkdirSync(path.join(proj, ".logscope"), { recursive: true });
	fs.writeFileSync(
		path.join(proj, ".logscope", "config.json"),
		JSON.stringify({ sources: [] })
	);
	const s = await startServer({ projectDir: proj, port: 0 });
	const base = `http://127.0.0.1:${s.server.address().port}`;
	t.after(async () => {
		await s.store.close();
		s.server.close();
		fs.rmSync(proj, { recursive: true, force: true });
	});
	const api = async (p, body) => {
		const r = await fetch(base + p, {
			method: body ? "POST" : "GET",
			headers: body ? { "content-type": "application/json" } : undefined,
			body: body ? JSON.stringify(body) : undefined,
		});
		return { status: r.status, json: await r.json() };
	};
	return { api, s };
}

test("annotation create, update in place, anchor preserved", async (t) => {
	const { api } = await boot(t);

	const created = await api("/api/annotate", {
		kind: "analysis",
		text: "chunk 1/5: 0%",
		meta: { flash: true },
	});
	assert.equal(created.status, 200);
	const id = created.json.id;
	const seq = created.json.seq;
	assert.ok(id);

	const updated = await api("/api/annotate", {
		id,
		text: "chunk 1/5: 45%",
		meta: { pct: 45 },
	});
	assert.equal(updated.status, 200);
	assert.equal(updated.json.id, id);
	assert.equal(updated.json.seq, seq, "anchor must not move");
	assert.equal(updated.json.text, "chunk 1/5: 45%");
	assert.equal(updated.json.meta.flash, true, "meta merges, not replaces");
	assert.equal(updated.json.meta.pct, 45);
	assert.ok(updated.json.edited, "updates carry an edited stamp");

	// the annotation list holds ONE record, with the new text
	const list = await api("/api/annotations?from=0");
	const matches = list.json.annotations.filter((a) => a.id === id);
	assert.equal(matches.length, 1);
	assert.equal(matches[0].text, "chunk 1/5: 45%");

	// unknown id → 404, so clients can degrade to creating a fresh note
	const missing = await api("/api/annotate", { id: "a-999", text: "x" });
	assert.equal(missing.status, 404);
});

test("store journal replays to the updated text (last writer wins)", async (t) => {
	const { api, s } = await boot(t);
	const created = await api("/api/annotate", { text: "v1" });
	await api("/api/annotate", { id: created.json.id, text: "v2" });

	const file = fs.readFileSync(
		path.join(s.store.dir, "annotations.jsonl"),
		"utf8"
	);
	const recs = file.trim().split("\n").map((l) => JSON.parse(l));
	const mine = recs.filter((r) => r.id === created.json.id);
	assert.equal(mine.length, 2, "update is appended, not rewritten");
	assert.equal(mine.at(-1).text, "v2");
});
