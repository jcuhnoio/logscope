// File-tail ingestion.
//
// Reads a growing log file the way `tail -F` does. This exists so logscope can
// sit alongside a terminal that already owns the tty — a serial device can only
// be opened once, and taking it away from a running `tio` mid-session is not an
// acceptable failure mode. It also lets non-serial inputs (CI output, a CSMS
// server log) share the same timeline.
//
// Trade-off: read-only. `send` requires a `serial` source, which owns the port.

import fs from "node:fs";
import path from "node:path";
import { parseLine } from "./parse.js";
import { LineSplitter } from "./linesplit.js";

const POLL_MS = 150;

export class FileSource {
	constructor({ name, file, parse = parseLine, from = "end" }, store) {
		this.name = name;
		this.file = file.replace(/^~/, process.env.HOME ?? "~");
		this.parse = parse;
		this.store = store;
		this.from = from; // "end" (only new output) | "start" (replay whole file)

		this.pos = 0;
		this.ino = null;
		this.buf = "";
		this.splitter = new LineSplitter();
		this.connected = false;
		this.lines = 0;
		this.lastAt = null;
		this.stopped = false;
		this.timer = null;
		this.warned = false;
	}

	async start() {
		this.stopped = false;
		this.#tick();
	}

	#tick() {
		if (this.stopped) return;
		try {
			const st = fs.statSync(this.file);

			if (this.ino === null) {
				this.ino = st.ino;
				this.pos = this.from === "start" ? 0 : st.size;
				this.#up(st);
			} else if (st.ino !== this.ino) {
				// Rotated or replaced — start over from the top of the new file.
				this.ino = st.ino;
				this.pos = 0;
				this.buf = "";
				this.store.addAnnotation({
					kind: "mark",
					author: "system",
					text: `${this.name}: log file rotated`,
					meta: { label: `${this.name} rotated`, port: this.name },
				});
			} else if (st.size < this.pos) {
				// Truncated in place.
				this.pos = 0;
				this.buf = "";
			}

			if (st.size > this.pos) this.#read(st.size);
			this.warned = false;
		} catch (err) {
			if (this.connected || !this.warned) {
				this.warned = true;
				if (this.connected) {
					this.store.addAnnotation({
						kind: "error",
						author: "system",
						text: `${this.name}: ${err.message}`,
						meta: { port: this.name },
					});
				}
			}
			this.connected = false;
			this.ino = null;
		}
		this.timer = setTimeout(() => this.#tick(), POLL_MS);
	}

	#up(st) {
		this.connected = true;
		this.store.addAnnotation({
			kind: "mark",
			author: "system",
			text: `${this.name} tailing ${this.file} (${st.size}B)`,
			meta: { label: `${this.name} up`, port: this.name },
		});
	}

	#read(size) {
		const len = size - this.pos;
		const fd = fs.openSync(this.file, "r");
		try {
			const b = Buffer.allocUnsafe(len);
			const n = fs.readSync(fd, b, 0, len, this.pos);
			this.pos += n;
			this.buf += b.subarray(0, n).toString("utf8");
		} finally {
			fs.closeSync(fd);
		}

		const parts = this.splitter.push(this.buf);
		this.buf = "";
		if (!parts.length) return;
		this.lastAt = Date.now();
		for (const raw of parts) {
			const p = this.parse(raw);
			this.store.addLine({ src: this.name, ...p });
			this.lines++;
		}
	}

	write() {
		throw new Error(
			`source "${this.name}" is a file tail (read-only). ` +
				`Sending requires a serial source that owns the port.`
		);
	}

	stop() {
		this.stopped = true;
		clearTimeout(this.timer);
		this.connected = false;
	}

	status() {
		return {
			name: this.name,
			device: this.file,
			type: "file",
			baud: null,
			connected: this.connected,
			lines: this.lines,
			lastAt: this.lastAt,
			writable: false,
		};
	}
}
