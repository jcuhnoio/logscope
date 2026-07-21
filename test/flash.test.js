import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { flashFirmware } from "../src/flash.js";

function setup(t) {
	const proj = fs.mkdtempSync(path.join(os.tmpdir(), "logscope-flash-"));
	const dir = path.join(proj, ".logscope");
	fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
	fs.writeFileSync(path.join(proj, "app.img"), "FWIMG");
	t.after(() => fs.rmSync(proj, { recursive: true, force: true }));

	const notes = [];
	const store = { addAnnotation: (a) => (notes.push(a), a), addLine: () => {} };
	const port = {
		name: "dev",
		acquired: 0,
		released: 0,
		acquireRaw() {
			this.acquired++;
		},
		releaseRaw() {
			this.released++;
		},
	};
	const cfg = { _dir: dir, _project: proj };
	return { proj, dir, notes, store, port, cfg };
}

test("refuses without a configured script", async (t) => {
	const { proj, store, port, cfg } = setup(t);
	await assert.rejects(
		() => flashFirmware({ port, file: path.join(proj, "app.img"), store, cfg }),
		/no flash script configured/
	);
	assert.equal(port.acquired, 0); // refused before touching the port
});

test("runs the script with merged opts and merges its result", async (t) => {
	const { proj, dir, notes, store, port, cfg } = setup(t);
	fs.writeFileSync(
		path.join(dir, "scripts", "ok.mjs"),
		`export default async ({ data, note, opts }) => {
			note("analysis", "len=" + data.length + " prompt=" + opts.prompt + " extra=" + opts.extra);
			return { blocks: 7, confirmed: true };
		}`
	);
	cfg.flash = { script: "scripts/ok.mjs", prompt: "d:/>" };
	const r = await flashFirmware({
		port,
		file: path.join(proj, "app.img"),
		store,
		cfg,
		opts: { extra: 42 },
	});
	assert.equal(r.ok, true);
	assert.equal(r.blocks, 7);
	assert.equal(r.bytes, 5);
	assert.equal(port.acquired, 1);
	assert.equal(port.released, 1);
	assert.equal(notes.find((n) => n.kind === "analysis")?.text, "len=5 prompt=d:/> extra=42");
	// the opening mark records which script ran
	assert.match(notes[0].meta.script, /ok\.mjs$/);
});

test("a throwing script still releases raw mode", async (t) => {
	const { proj, dir, store, port, cfg } = setup(t);
	fs.writeFileSync(
		path.join(dir, "scripts", "boom.mjs"),
		`export default () => { throw new Error("boom"); }`
	);
	cfg.flash = { script: "scripts/boom.mjs" };
	await assert.rejects(
		() => flashFirmware({ port, file: path.join(proj, "app.img"), store, cfg }),
		/boom/
	);
	assert.equal(port.released, 1);
});

test("missing script file and missing image are clear errors", async (t) => {
	const { proj, store, port, cfg } = setup(t);
	cfg.flash = { script: "scripts/nope.mjs" };
	await assert.rejects(
		() => flashFirmware({ port, file: path.join(proj, "app.img"), store, cfg }),
		/flash script not found/
	);

	const { dir: dir2, store: s2, port: p2, cfg: c2, proj: proj2 } = setup(t);
	fs.writeFileSync(path.join(dir2, "scripts", "ok.mjs"), `export default async () => ({})`);
	c2.flash = { script: "scripts/ok.mjs" };
	await assert.rejects(
		() => flashFirmware({ port: p2, file: path.join(proj2, "ghost.img"), store: s2, cfg: c2 }),
		/no such file/
	);
});

test("script edits are picked up without a restart (mtime cache-bust)", async (t) => {
	const { proj, dir, store, port, cfg } = setup(t);
	const sp = path.join(dir, "scripts", "v.mjs");
	cfg.flash = { script: "scripts/v.mjs" };
	fs.writeFileSync(sp, `export default async () => ({ version: 1 })`);
	const r1 = await flashFirmware({ port, file: path.join(proj, "app.img"), store, cfg });
	assert.equal(r1.version, 1);
	fs.writeFileSync(sp, `export default async () => ({ version: 2 })`);
	// ensure a distinct mtime even on coarse-grained filesystems
	fs.utimesSync(sp, new Date(), new Date(Date.now() + 1000));
	const r2 = await flashFirmware({ port, file: path.join(proj, "app.img"), store, cfg });
	assert.equal(r2.version, 2);
});
