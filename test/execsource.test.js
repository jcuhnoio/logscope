// Exec source: spawn a command, ingest stdout, restart on exit, stdin via send.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";

async function boot(t, sources) {
	const proj = fs.mkdtempSync(path.join(os.tmpdir(), "logscope-exec-"));
	fs.mkdirSync(path.join(proj, ".logscope"), { recursive: true });
	fs.writeFileSync(
		path.join(proj, ".logscope", "config.json"),
		JSON.stringify({ sources })
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
	return { api, s };
}

test("exec source ingests stdout and reports status", async (t) => {
	const { api } = await boot(t, [
		{
			name: "gen",
			type: "exec",
			cmd: "printf 'alpha\\nBootNotification Accepted\\n'; sleep 60",
		},
	]);

	const w = await api("/api/wait", {
		pattern: "Accepted",
		timeout: 5000,
		since: 0,
	});
	assert.equal(w.json.timedOut, false);
	assert.equal(w.json.matched.raw, "BootNotification Accepted");

	const st = await api("/api/status");
	const port = st.json.ports.find((p) => p.name === "gen");
	assert.equal(port.type, "exec");
	assert.equal(port.connected, true);
	assert.equal(port.writable, false);

	// read-only: send must 409, not crash the child
	const snd = await api("/api/send", { port: "gen", data: "hi" });
	assert.equal(snd.status, 409);
	assert.match(snd.json.error, /read-only/);
});

test("exec source restarts after exit", async (t) => {
	const { api } = await boot(t, [
		// Each run emits one line with its own pid, then dies. A respawn is
		// therefore observable as a second, different line.
		{ name: "flappy", type: "exec", cmd: "echo run-$$" },
	]);

	const first = await api("/api/wait", {
		pattern: "run-",
		timeout: 5000,
		since: 0,
	});
	assert.equal(first.json.timedOut, false);

	const second = await api("/api/wait", {
		pattern: "run-",
		timeout: 5000,
		since: first.json.matched.seq,
	});
	assert.equal(second.json.timedOut, false, "child was not respawned");
	assert.notEqual(second.json.matched.raw, first.json.matched.raw);
});

test("writable exec source connects stdin to send", async (t) => {
	const { api } = await boot(t, [
		{ name: "cat", type: "exec", cmd: "cat", writable: true },
	]);

	const waiting = api("/api/wait", {
		pattern: "hello-stdin",
		timeout: 5000,
		since: 0,
	});
	const snd = await api("/api/send", {
		port: "cat",
		data: "hello-stdin",
		newline: "\n",
	});
	assert.equal(snd.status, 200);
	const w = await waiting;
	assert.equal(w.json.timedOut, false);
	assert.equal(w.json.matched.raw, "hello-stdin");
});
