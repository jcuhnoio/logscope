// logscope daemon: ingestion + query API + SSE + static web UI.
// Loopback only, no auth, no dependencies.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { Store } from "./store.js";
import { SerialPort, probeDevice } from "./serial.js";
import { FileSource } from "./filesource.js";
import { compileRules, makeParser } from "./parse.js";
import { whoHolds } from "./holder.js";
import { flashFirmware } from "./flash.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, "..", "web");

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
};

const DEFAULT_CONFIG = {
	port: 7717,
	sources: [],
	parsers: null, // null → every built-in preset; [] → raw; see doc/CONFIG.md
	rules: [],
	commands: {},
	flash: null, // { script: ".logscope/scripts/…", …defaults } — device-specific
};

/**
 * Parser for one source: source-level `parsers`/`rules` override/extend the
 * global ones. Throws on an unknown preset name — a typo here should stop the
 * daemon at startup, not silently un-parse every line.
 */
function sourceParser(cfg, s = {}) {
	return makeParser({
		presets: s.parsers ?? cfg.parsers ?? null,
		rules: compileRules([...(s.rules ?? []), ...(cfg.rules ?? [])]),
	});
}

/**
 * Re-read the hot-reloadable parts of config.json: `commands` and `flash`.
 *
 * Both are edited far more often than the daemon is restarted, and a stale
 * alias fails in the worst possible way: the run succeeds, so nothing looks
 * wrong, but it did the old thing. (Caught the hard way — an edited `build`
 * alias kept building the wrong modem variant and flashing it to the board.)
 * Sources and parsers deliberately do NOT hot-reload; re-opening a tty
 * mid-session is a different and much more disruptive operation.
 */
function refreshCommands(cfg) {
	const file = path.join(cfg._dir, "config.json");
	try {
		const disk = JSON.parse(fs.readFileSync(file, "utf8"));
		if (disk && typeof disk.commands === "object") cfg.commands = disk.commands;
		if (disk && "flash" in disk) cfg.flash = disk.flash;
	} catch {
		// Keep the last good table; a half-saved file shouldn't break a run.
	}
	return cfg;
}
const refreshFlash = refreshCommands;

export function loadConfig(projectDir) {
	const dir = path.join(projectDir, ".logscope");
	const file = path.join(dir, "config.json");
	let cfg = { ...DEFAULT_CONFIG };
	if (fs.existsSync(file)) {
		try {
			cfg = { ...cfg, ...JSON.parse(fs.readFileSync(file, "utf8")) };
		} catch (err) {
			throw new Error(`bad ${file}: ${err.message}`);
		}
	}
	cfg._dir = dir;
	cfg._project = projectDir;
	cfg._notes = path.join(dir, "knowledge.md");
	return cfg;
}

export async function startServer({ projectDir, port }) {
	const cfg = loadConfig(projectDir);
	fs.mkdirSync(cfg._dir, { recursive: true });
	const listenPort = port ?? cfg.port ?? 7717;

	const store = new Store(cfg._dir);

	const sources = new Map();
	for (const s of cfg.sources ?? []) {
		const parse = sourceParser(cfg, s);
		const src =
			s.type === "file"
				? new FileSource({ ...s, parse }, store)
				: new SerialPort({ ...s, parse }, store);
		sources.set(s.name, src);
		await src.start();
	}

	// Per-project scripting home (flash scripts and friends). Seeded with the
	// contract doc so an empty folder still explains itself.
	const scriptsDir = path.join(cfg._dir, "scripts");
	if (!fs.existsSync(scriptsDir)) {
		fs.mkdirSync(scriptsDir, { recursive: true });
		fs.writeFileSync(path.join(scriptsDir, "README.md"), scriptsReadme());
	}

	// Optional plain-text mirror, so the tio-style log file people already
	// `tail` and grep keeps existing once logscope owns the port.
	if (cfg.mirror) {
		const mp = cfg.mirror.replace(/^~/, process.env.HOME ?? "~");
		fs.mkdirSync(path.dirname(mp), { recursive: true });
		const ms = fs.createWriteStream(mp, { flags: "a" });
		store.subscribe((event, rec) => {
			if (event !== "line") return;
			const ts = new Date(rec.t).toTimeString().slice(0, 8);
			const ms3 = String(rec.t % 1000).padStart(3, "0");
			ms.write(`[${ts}.${ms3}] ${sources.size > 1 ? `<${rec.src}> ` : ""}${rec.raw}\n`);
		});
	}

	if (!fs.existsSync(cfg._notes)) {
		fs.writeFileSync(cfg._notes, seedNotes(cfg._project));
	}

	const server = http.createServer((req, res) => {
		handle(req, res, { store, sources, cfg }).catch((err) => {
			send(res, 500, { error: String(err?.message ?? err) });
		});
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(listenPort, "127.0.0.1", resolve);
	});

	const shutdown = () => {
		for (const s of sources.values()) s.stop();
		store.close();
		server.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	return { server, store, sources, cfg, port: listenPort };
}

// ---------------------------------------------------------------------------

async function handle(req, res, ctx) {
	const url = new URL(req.url, "http://127.0.0.1");
	const p = url.pathname;
	const q = url.searchParams;
	const { store, sources, cfg } = ctx;

	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Headers", "content-type");
	res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,OPTIONS");
	if (req.method === "OPTIONS") return void res.writeHead(204).end();

	// ---- static ----
	if (!p.startsWith("/api/")) return serveStatic(p, res);

	// ---- status ----
	if (p === "/api/status") {
		return send(res, 200, status(store, sources, refreshCommands(cfg)));
	}

	// ---- device discovery ----
	if (p === "/api/devices") {
		return send(res, 200, { devices: listDevices(sources) });
	}

	// ---- lines ----
	if (p === "/api/lines") {
		const r = await store.query({
			from: num(q.get("from"), 0),
			to: q.get("to") ? num(q.get("to")) : null,
			limit: num(q.get("limit"), 200),
			src: q.get("src") || undefined,
			grep: q.get("grep") || undefined,
			flags: q.get("flags") || "",
			level: q.get("level") || undefined,
			tag: q.get("tag") || undefined,
			order: q.get("order") === "desc" ? "desc" : "asc",
		});
		return send(res, 200, { ...r, head: store.head });
	}

	if (p === "/api/annotations") {
		return send(res, 200, {
			annotations: store.annotationsIn(num(q.get("from"), 0), q.get("to") ? num(q.get("to")) : null),
		});
	}

	// ---- SSE ----
	if (p === "/api/stream") return stream(req, res, store, sources, cfg, num(q.get("from"), -1));

	// ---- notes (GET) ----
	if (p === "/api/notes" && req.method === "GET") {
		const md = fs.existsSync(cfg._notes) ? fs.readFileSync(cfg._notes, "utf8") : "";
		const st = fs.existsSync(cfg._notes) ? fs.statSync(cfg._notes) : null;
		return send(res, 200, { markdown: md, path: cfg._notes, mtime: st ? st.mtimeMs : 0 });
	}

	// ---- everything below takes a body ----
	const body = await readBody(req);

	if (p === "/api/wait") {
		let re;
		try {
			re = new RegExp(body.pattern ?? "", body.flags ?? "");
		} catch (err) {
			return send(res, 400, { error: `bad pattern: ${err.message}` });
		}
		const r = await store.wait({
			re,
			src: body.src || null,
			since: num(body.since, store.head),
			timeout: num(body.timeout, 60_000),
			context: num(body.context, 3),
		});
		return send(res, 200, r);
	}

	if (p === "/api/summary") {
		return send(
			res,
			200,
			store.summary({
				since: num(body.since, 0),
				to: body.to != null ? num(body.to) : null,
				src: body.src || null,
			})
		);
	}

	if (p === "/api/annotate") {
		if (!body.text) return send(res, 400, { error: "text is required" });
		return send(res, 200, store.addAnnotation(body));
	}

	if (p === "/api/mark") {
		return send(
			res,
			200,
			store.addAnnotation({
				kind: "mark",
				author: body.author ?? "claude",
				text: body.label ?? "",
				meta: { label: body.label ?? "" },
			})
		);
	}

	if (p === "/api/send") {
		const name = body.port ?? [...sources.keys()][0];
		const src = sources.get(name);
		if (!src) return send(res, 404, { error: `no such source: ${name}` });
		const nl = body.newline ?? "\r\n";
		const at = store.head;
		try {
			src.write(String(body.data ?? "") + nl);
		} catch (err) {
			return send(res, 409, { error: String(err.message) });
		}
		const ann =
			body.annotate === false
				? null
				: store.addAnnotation({
						seq: at,
						kind: "command",
						author: body.author ?? "claude",
						text: `→ ${body.data}`,
						meta: { port: name, data: body.data },
					});
		return send(res, 200, { ok: true, seq: at, annotation: ann });
	}

	if (p === "/api/run") {
		return run(res, body, store, refreshCommands(cfg), sources);
	}

	if (p === "/api/flash") {
		const name = body.port ?? [...sources.keys()][0];
		const src = sources.get(name);
		if (!src) return send(res, 404, { error: `no such source: ${name}` });
		if (typeof src.acquireRaw !== "function") {
			return send(res, 409, { error: `source "${name}" is not a writable serial port` });
		}
		let file = body.file;
		if (!file) return send(res, 400, { error: "file is required" });
		if (!path.isAbsolute(file)) file = path.join(cfg._project, file);

		const at = store.head;
		try {
			const r = await flashFirmware({
				port: src,
				file,
				store,
				cfg: refreshFlash(cfg),
				opts: { ...body, author: body.author ?? "claude" },
			});
			return send(res, 200, { ...r, seq: at, cursor: store.head });
		} catch (err) {
			return send(res, 500, {
				error: String(err?.message ?? err),
				seq: at,
				cursor: store.head,
			});
		}
	}

	// ---- attach/switch a serial device at runtime ----
	if (p === "/api/attach") {
		// Default to replacing the first (usually only) serial source rather than
		// inventing a name — a hardcoded default here would silently create a
		// second source instead of switching the one being looked at.
		const name = body.name ?? [...sources.keys()][0] ?? "device";
		const device = body.device;
		if (!device) return send(res, 400, { error: "device is required" });
		const baud = num(body.baud, 115200);

		const prev = sources.get(name);
		if (prev) {
			if (prev.device === device && prev.baud === baud && prev.connected) {
				return send(res, 200, { ok: true, unchanged: true, ports: status(store, sources, cfg).ports });
			}
		}

		// Validate before destroying anything. The old source is still capturing
		// at this point, and a failed switch must leave it that way — losing a
		// live session to a mistyped device name is not recoverable.
		if (!prev || prev.device !== device) {
			const why = probeDevice(device);
			if (why) {
				return send(res, 409, { error: why, ports: status(store, sources, cfg).ports });
			}
		}

		if (prev) {
			prev.stop();
			sources.delete(name);
		}

		const next = new SerialPort(
			{ name, device, baud, parse: sourceParser(cfg) },
			store
		);
		sources.set(name, next);
		await next.start();

		if (!next.connected) {
			return send(res, 409, {
				error: next.lastError ?? `could not open ${device}`,
				ports: status(store, sources, cfg).ports,
			});
		}
		store.addAnnotation({
			kind: "mark",
			author: body.author ?? "user",
			text: `switched ${name} → ${device} @ ${baud}`,
			meta: { label: `→ ${device}`, port: name },
		});
		return send(res, 200, { ok: true, ports: status(store, sources, cfg).ports });
	}

	if (p === "/api/notes" && (req.method === "PUT" || req.method === "PATCH")) {
		const cur = fs.existsSync(cfg._notes) ? fs.readFileSync(cfg._notes, "utf8") : "";
		const next =
			req.method === "PATCH"
				? cur.replace(/\s*$/, "") + "\n" + (body.append ?? "") + "\n"
				: (body.markdown ?? "");
		fs.writeFileSync(cfg._notes, next);
		return send(res, 200, { ok: true, mtime: fs.statSync(cfg._notes).mtimeMs, bytes: next.length });
	}

	return send(res, 404, { error: `no route: ${req.method} ${p}` });
}

// Serial devices the UI can offer in its picker. macOS exposes each adapter
// twice (cu.* callout / tty.* dialin); only cu.* is usable here, and the
// built-in Bluetooth and debug nodes are never what anyone wants.
const DEV_DIRS = ["/dev"];
const DEV_MATCH =
	process.platform === "linux"
		? /^(ttyUSB|ttyACM|ttyAMA|ttyS)\d+$/
		: /^cu\./;
const DEV_SKIP = /Bluetooth|debug-console|wlan-debug/i;

// Real USB-serial adapters. Everything else on macOS's /dev/cu.* list is a
// paired Bluetooth device (headphones, speakers) that merely exposes an RFCOMM
// node — never the thing anyone means. They're kept but ranked below and
// flagged, rather than hidden, in case someone genuinely uses an odd adapter.
const DEV_LIKELY = /usbserial|usbmodem|SLAB|wchusb|ftdi|UART/i;

function listDevices(sources) {
	const inUse = new Map();
	for (const s of sources.values()) {
		const st = s.status();
		if (st.type === "serial") inUse.set(st.device, st.name);
	}

	const out = [];
	for (const dir of DEV_DIRS) {
		let names = [];
		try {
			names = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const n of names) {
			if (!DEV_MATCH.test(n) || DEV_SKIP.test(n)) continue;
			const full = path.join(dir, n);
			out.push({
				device: full,
				label: n.replace(/^cu\./, ""),
				likely: DEV_LIKELY.test(n),
				attachedAs: inUse.get(full) ?? null,
				heldBy: inUse.has(full) ? null : whoHolds(full),
			});
		}
	}
	return out.sort(
		(a, b) => Number(b.likely) - Number(a.likely) || a.label.localeCompare(b.label)
	);
}

function status(store, sources, cfg) {
	return {
		sessionId: store.sessionId,
		startedAt: store.startedAt,
		head: store.head,
		project: cfg._project,
		dir: store.dir,
		notes: cfg._notes,
		// `_`-prefixed keys are comments — JSON has none of its own.
		commands: Object.keys(cfg.commands ?? {}).filter((k) => !k.startsWith("_")),
		ports: [...sources.values()].map((s) => s.status()),
	};
}

async function run(res, body, store, cfg, sources) {
	// Named aliases from config keep long invocations out of the agent's context
	// and out of its guesswork: `logscope run flash` beats retyping the whole
	// XMODEM line. Anything after the alias name is appended, so
	// `run flash build/x.dxi` works.
	const raw = String(body.cmd ?? "").trim();
	if (!raw) return send(res, 400, { error: "cmd is required" });
	const first = raw.split(/\s+/)[0];
	const rawAlias = cfg.commands?.[first];
	const a = typeof rawAlias === "string" ? { cmd: rawAlias } : (rawAlias ?? null);

	let cmd = raw;
	if (a) {
		const extra = raw.slice(first.length).trim();
		cmd = a.cmd + (extra ? " " + extra : "");
	}

	const detachName = body.detachPort ?? a?.detachPort ?? null;
	const port = detachName ? sources.get(detachName) : null;
	if (detachName && !port) {
		return send(res, 404, { error: `detachPort: no such source "${detachName}"` });
	}

	// {device}/{baud} come from the live source, so an alias never hardcodes a
	// tty path that goes stale the moment someone switches adapters.
	if (port) {
		const st = port.status();
		cmd = cmd.replace(/\{device\}/g, st.device).replace(/\{baud\}/g, String(st.baud ?? ""));
	}

	const cwd = body.cwd ?? a?.cwd ?? cfg._project;
	const label = body.label ?? a?.label ?? first;
	const timeout = num(body.timeout, a?.timeout ?? null) || 120_000;

	const at = store.head;
	const started = Date.now();
	store.addAnnotation({
		seq: at,
		kind: "run",
		author: body.author ?? "claude",
		text: `$ ${label}`,
		meta: { cmd, cwd, state: "running", detached: detachName ?? undefined },
	});

	// A tool that drives the device itself (XMODEM flashing, a bootloader
	// dialogue) needs the tty, and only one process may hold it. Hand the port
	// over for the duration and take it back afterwards — the command's own
	// stdout is captured, so the transfer is still on the record.
	if (port) {
		port.stop();
		store.addAnnotation({
			kind: "mark",
			author: "system",
			text: `released ${detachName} to "${label}"`,
			meta: { label: `port released → ${label}`, port: detachName },
		});
	}
	const reattach = async () => {
		if (!port) return;
		await new Promise((r) => setTimeout(r, 400)); // let the tty settle
		try {
			await port.start();
			sources.set(detachName, port);
		} catch (err) {
			store.addAnnotation({
				kind: "error",
				author: "system",
				text: `could not re-open ${detachName} after "${label}": ${err.message}`,
				meta: { port: detachName },
			});
		}
	};

	return new Promise((resolve) => {
		execFile(
			"/bin/sh",
			["-c", cmd],
			{ cwd, timeout, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
			async (err, stdout, stderr) => {
				const ms = Date.now() - started;
				const exit = err ? (err.code ?? 1) : 0;
				const id = `run-${Date.now()}`;
				// Take the port back before reporting, so by the time the caller
				// sees the result the log is live again and a follow-up `wait`
				// cannot miss the device's post-flash boot output.
				await reattach();
				try {
					fs.writeFileSync(
						path.join(store.dir, "runs", `${id}.txt`),
						`$ ${cmd}\ncwd: ${cwd}\nexit: ${exit}  ${ms}ms\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`
					);
				} catch {}
				const tail = (s) => (s.length > 2000 ? "…" + s.slice(-2000) : s);
				const ann = store.addAnnotation({
					kind: "run",
					author: body.author ?? "claude",
					text: `$ ${label} → exit ${exit} (${ms}ms)`,
					meta: {
						cmd,
						cwd,
						exit,
						ms,
						state: "done",
						runId: id,
						stdout_tail: tail(stdout),
						stderr_tail: tail(stderr),
					},
				});
				send(res, 200, {
					exit,
					ms,
					resolved: cmd,
					seq: at,
					cursor: store.head,
					stdout: stdout.slice(0, 8192),
					stderr: stderr.slice(0, 8192),
					truncated: stdout.length > 8192 || stderr.length > 8192,
					runFile: path.join(store.dir, "runs", `${id}.txt`),
					annotation: ann,
				});
				resolve();
			}
		);
	});
}

function stream(req, res, store, sources, cfg, from) {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	const write = (event, data) => {
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	};

	write("status", status(store, sources, cfg));
	if (from >= 0) {
		for (const l of store.memSlice(from, store.head)) write("line", l);
		for (const a of store.annotationsIn(from)) write("annotation", a);
	}

	const off = store.subscribe(write);
	const ping = setInterval(() => write("ping", {}), 15_000);
	const statusTick = setInterval(() => write("status", status(store, sources, cfg)), 5_000);
	const done = () => {
		clearInterval(ping);
		clearInterval(statusTick);
		off();
	};
	req.on("close", done);
	req.on("error", done);
}

function serveStatic(p, res) {
	const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
	const file = path.join(WEB, rel);
	if (!file.startsWith(WEB)) return send(res, 403, { error: "nope" });
	if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
		return send(res, 404, { error: "not found" });
	}
	res.writeHead(200, {
		"Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
		"Cache-Control": "no-cache",
	});
	fs.createReadStream(file).pipe(res);
}

function send(res, code, obj) {
	const b = Buffer.from(JSON.stringify(obj));
	res.writeHead(code, { "Content-Type": "application/json", "Content-Length": b.length });
	res.end(b);
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let s = "";
		req.on("data", (c) => {
			s += c;
			if (s.length > 8 * 1024 * 1024) reject(new Error("body too large"));
		});
		req.on("end", () => {
			if (!s) return resolve({});
			try {
				resolve(JSON.parse(s));
			} catch (e) {
				reject(new Error(`bad JSON body: ${e.message}`));
			}
		});
		req.on("error", reject);
	});
}

function num(v, d = 0) {
	const n = Number(v);
	return Number.isFinite(n) ? n : d;
}

function scriptsReadme() {
	return `# .logscope/scripts/

Device-specific automation lives here, out of logscope itself. Starts empty on
purpose: everything about *how* to drive your particular hardware belongs to
the project, not the tool.

## Flash scripts

\`logscope flash <file>\` runs the ES module named by \`flash.script\` in
config.json (path relative to this directory or the project root). Use the
\`.mjs\` extension — a bare \`.js\` outside a \`"type": "module"\` package is
parsed as CommonJS and \`export\` fails:

\`\`\`json
{ "flash": { "script": "scripts/flash.mjs", "promptTimeout": 20000 } }
\`\`\`

The script exports one async function and drives the port in raw mode; the
daemon handles raw-mode acquire/release around it, so a throw can never leave
the log silent. Every key in the \`flash\` object is passed through as
\`ctx.opts\`, merged with per-call options.

\`\`\`js
export default async function flash({ port, data, file, note, echo, xmodem, opts }) {
  // port.write(str)                      write to the tty
  // port.rawFlush()                      drop unread bytes
  // await port.rawReadUntil(text, ms, echo)  → { ok, text }
  // note(kind, text, meta?)              annotate the timeline
  //   kinds: note | analysis | command | run | mark | error
  // echo(text)                           mirror device output into the log
  // await xmodem(data, { onProgress, onNote, startTimeout })  XMODEM-1K send
  //   → { ok, blocks, retries } | { ok: false, error }
  throw new Error("not implemented");   // throw = flash failed
  return {};                            // merged into the API response
}
\`\`\`

Edits are picked up on the next flash — no daemon restart needed.

## Anything else

Shell scripts / one-off tools driven via \`logscope run\` can live here too;
reference them from the \`commands\` table in config.json.
`;
}

function seedNotes(project) {
	return `# logscope knowledge — ${path.basename(project)}

Durable notes about *this* system: what the logs mean, which commands drive
which flow, and what "good" looks like. Both you and Claude edit this file.
It is the thing that stops you re-explaining the setup every session.

## Setup

<!-- Which port is what. What is on the other end. How to power-cycle. -->

## Reading the logs

<!-- Tag glossary, notable message shapes, what a healthy boot looks like. -->

## Procedures

<!-- Step-by-step flows: how to trigger a firmware update, what to wait for. -->

## Gotchas

<!-- Things that burned us. Timing, races, misleading messages. -->
`;
}
