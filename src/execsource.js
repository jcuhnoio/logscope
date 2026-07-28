// Exec ingestion.
//
// Spawns a command and ingests its stdout as a source, line by line. This is
// how remote or synthesized streams join the timeline without the tee-to-a-
// file-and-tail dance: `ssh pi 'sniffer eth1'`, `adb logcat`, `docker logs -f`,
// a python decoder — anything that prints lines.
//
// The child is supervised: if it exits (network drop, device reboot), it is
// respawned with a capped backoff, and the up/down transitions land in the
// timeline as system marks so gaps are explainable. Backoff resets once a
// spawn proves healthy (produces a line or survives HEALTHY_MS).
//
// `writable: true` connects the child's stdin to `send`, so an interactive
// remote process (e.g. `ssh device 'console'`) can be driven like a serial
// port. Default is read-only.

import { spawn } from "node:child_process";
import { parseLine } from "./parse.js";
import { LineSplitter } from "./linesplit.js";

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const HEALTHY_MS = 60_000;

export class ExecSource {
	constructor(
		{ name, cmd, parse = parseLine, restart = true, writable = false },
		store
	) {
		this.name = name;
		this.cmd = cmd;
		this.parse = parse;
		this.store = store;
		this.restart = restart;
		this.writable = writable;

		this.child = null;
		this.splitter = new LineSplitter();
		this.connected = false;
		this.lines = 0;
		this.lastAt = null;
		this.stopped = false;
		this.timer = null;
		this.failures = 0;
		this.spawnedAt = 0;
	}

	async start() {
		this.stopped = false;
		this.#spawn();
	}

	#spawn() {
		if (this.stopped) return;
		this.spawnedAt = Date.now();
		// detached → own process group, so stop() can kill the whole pipeline
		// (an `ssh … | decoder` child would otherwise outlive its sh wrapper
		// and keep the stdout pipe — and the daemon's event loop — alive).
		const child = spawn("sh", ["-c", this.cmd], {
			stdio: [this.writable ? "pipe" : "ignore", "pipe", "pipe"],
			detached: true,
		});
		this.child = child;
		this.connected = true;
		this.store.addAnnotation({
			kind: "mark",
			author: "system",
			text: `${this.name}: exec started (pid ${child.pid})`,
			meta: { label: `${this.name} up`, port: this.name },
		});

		child.stdout.on("data", (b) => this.#ingest(b));
		// stderr lines join the timeline too — an ssh "connection refused" is
		// exactly the line that explains the gap that follows.
		const errSplit = new LineSplitter();
		child.stderr.on("data", (b) => {
			for (const raw of errSplit.push(b.toString("utf8"))) {
				this.store.addLine({ src: this.name, raw, lvl: "err", msg: raw });
				this.lines++;
			}
		});
		child.on("error", (err) => this.#down(`spawn failed: ${err.message}`));
		child.on("exit", (code, signal) => {
			if (child !== this.child) return; // superseded by a newer spawn
			this.#down(
				signal ? `exited on ${signal}` : `exited with code ${code ?? "?"}`
			);
		});
	}

	#ingest(buf) {
		const parts = this.splitter.push(buf.toString("utf8"));
		if (!parts.length) return;
		this.failures = 0; // producing output = healthy
		this.lastAt = Date.now();
		for (const raw of parts) {
			const p = this.parse(raw);
			this.store.addLine({ src: this.name, ...p });
			this.lines++;
		}
	}

	#down(why) {
		if (!this.connected) return;
		this.connected = false;
		this.child = null;
		this.store.addAnnotation({
			kind: this.stopped ? "mark" : "error",
			author: "system",
			text: `${this.name}: ${why}`,
			meta: { port: this.name },
		});
		if (this.stopped || !this.restart) return;

		if (Date.now() - this.spawnedAt > HEALTHY_MS) this.failures = 0;
		const delay = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)];
		this.failures++;
		this.timer = setTimeout(() => this.#spawn(), delay);
	}

	write(data) {
		if (!this.writable || !this.child?.stdin) {
			throw new Error(
				`source "${this.name}" is an exec stream (read-only). ` +
					`Set "writable": true on the source to connect stdin.`
			);
		}
		this.child.stdin.write(data);
	}

	stop() {
		this.stopped = true;
		clearTimeout(this.timer);
		const child = this.child;
		this.child = null;
		if (child) {
			this.connected = false;
			try {
				process.kill(-child.pid, "SIGTERM"); // whole group
			} catch {
				child.kill("SIGTERM");
			}
			child.stdout?.destroy();
			child.stderr?.destroy();
		}
	}

	status() {
		return {
			name: this.name,
			device: this.cmd,
			type: "exec",
			baud: null,
			connected: this.connected,
			lines: this.lines,
			lastAt: this.lastAt,
			writable: this.writable,
		};
	}
}
