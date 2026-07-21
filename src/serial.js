// Serial ingestion without a native module.
//
// We configure the tty with stty(1) and read/write the device node directly.
// That keeps the tool dependency-free and, unlike shelling out to tio/screen,
// gives us a real write path for sending CLI commands.
//
// Two macOS constraints shaped this, both found the hard way:
//
//  1. A *blocking* open of /dev/cu.* hangs indefinitely, `clocal` or not. So the
//     fd must be O_NONBLOCK.
//  2. Neither fs.createReadStream nor net.Socket can consume a non-blocking TTY
//     fd — the former throws EAGAIN, the latter ERR_INVALID_FD_TYPE.
//
// So reads are an explicit poll loop that treats EAGAIN as "nothing yet". At
// 115200 baud (~11.5 KB/s) a 10-40 ms tick with a 64 KB buffer keeps up with
// enormous headroom, and the syscall cost when idle is negligible.

import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseLine } from "./parse.js";
import { whoHolds } from "./holder.js";

const execFileP = promisify(execFile);
const isLinux = process.platform === "linux";

const READ_BUF = 65536;
const TICK_BUSY = 10; // ms, while data is flowing
const TICK_IDLE = 40; // ms, after a stretch of nothing
const IDLE_AFTER = 20; // consecutive empty ticks before backing off

// Discard whatever is sitting in the tty buffer immediately after we configure
// it: when a previous owner (tio) exits, the line reverts to its default baud,
// so anything received in that gap decodes as garbage.
const DRAIN_MS = 250;

// Flush a line that never got a newline (shell prompts like "$ ") so the UI and
// the agent still see it.
const PARTIAL_FLUSH_MS = 400;

// Block the thread briefly. Only ever used to let a full tty output buffer
// drain mid-write, where we are already committed to a synchronous call.
const SLEEP_SAB = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
	Atomics.wait(SLEEP_SAB, 0, 0, ms);
}

/**
 * Can we open this device right now? Returns null if yes, else a human reason.
 *
 * Callers use this to validate a switch *before* tearing down the source that
 * is currently working — otherwise one mis-click in a device dropdown silently
 * destroys a live capture session, which is unrecoverable.
 */
export function probeDevice(device) {
	let fd = null;
	try {
		fd = fs.openSync(
			device,
			fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK
		);
		return null;
	} catch (err) {
		if (err?.code === "EBUSY" || err?.code === "EAGAIN") {
			const holder = whoHolds(device);
			return `${device} is held by ${holder ?? "another process"} — close it first`;
		}
		if (err?.code === "ENOENT") return `${device} does not exist (unplugged?)`;
		if (err?.code === "EACCES") return `no permission to open ${device}`;
		return `${device}: ${err.message}`;
	} finally {
		try {
			if (fd != null) fs.closeSync(fd);
		} catch {}
	}
}

export class SerialPort {
	constructor({ name, device, baud = 115200, parse = parseLine }, store) {
		this.name = name;
		this.device = device;
		this.baud = baud;
		this.parse = parse;
		this.store = store;

		this.fd = null;
		this.buf = Buffer.allocUnsafe(READ_BUF);
		this.pending = "";
		this.connected = false;
		this.draining = false;
		this.lines = 0;
		this.lastAt = null;
		this.idleTicks = 0;
		this.stopped = false;
		this.retryMs = 1000;
		this.timer = null;
		this.partialTimer = null;
		this.lastWasBlank = false;
		this.lastError = null;

		this.rawMode = false;
		this.rawBuf = Buffer.alloc(0);
		this.rawWaiter = null;
	}

	async start() {
		this.stopped = false;
		await this.#open();
	}

	async #open() {
		if (this.stopped) return;
		try {
			this.fd = fs.openSync(
				this.device,
				fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK
			);
			await this.#configure();

			this.draining = true;
			setTimeout(() => {
				this.draining = false;
			}, DRAIN_MS);

			this.connected = true;
			this.retryMs = 1000;
			this.idleTicks = 0;
			this.store.addAnnotation({
				kind: "mark",
				author: "system",
				text: `${this.name} connected (${this.device} @ ${this.baud})`,
				meta: { label: `${this.name} up`, port: this.name },
			});
			this.#pump();
		} catch (err) {
			if (err?.code === "EBUSY" || err?.code === "EAGAIN") {
				const holder = whoHolds(this.device);
				err = new Error(
					`${this.device} is held by ${holder ?? "another process"}. ` +
						`logscope needs exclusive ownership to send commands — close it first.`
				);
			}
			this.#drop(err);
		}
	}

	async #configure() {
		const flag = isLinux ? "-F" : "-f";
		await execFileP("stty", [
			flag, this.device,
			String(this.baud),
			"cs8", "-cstopb", "-parenb",
			"-crtscts", "clocal",
			"raw",
			"-echo", "-echoe", "-echok", "-echoctl", "-echoke",
			"-ixon", "-ixoff",
		]);
	}

	#pump() {
		if (this.stopped || !this.connected) return;
		let got = 0;
		for (;;) {
			let n = 0;
			try {
				n = fs.readSync(this.fd, this.buf, 0, READ_BUF, null);
			} catch (err) {
				if (err.code === "EAGAIN") break; // nothing available right now
				if (err.code === "EINTR") continue;
				return this.#drop(err);
			}
			if (n <= 0) break;
			got += n;
			if (!this.draining) {
				// The read buffer is reused, so raw consumers must get a copy.
				if (this.rawMode) this.#rawPush(Buffer.from(this.buf.subarray(0, n)));
				else this.#onData(this.buf.subarray(0, n));
			}
			if (n < READ_BUF) break;
		}

		this.idleTicks = got ? 0 : this.idleTicks + 1;
		this.timer = setTimeout(
			() => this.#pump(),
			this.idleTicks > IDLE_AFTER ? TICK_IDLE : TICK_BUSY
		);
	}

	#onData(chunk) {
		this.lastAt = Date.now();
		this.pending += chunk.toString("utf8");

		// Normalise line endings; devices are inconsistent. Two traps here, both
		// of which manufacture a blank line between every real one:
		//
		//  * `\r\r\n` — a firmware that writes "\r\n" through a driver that also
		//    maps NL→CRNL. Splitting on \r *or* \n sees two terminators, so the
		//    run of CRs before a LF has to be part of the same terminator.
		//  * a CRLF straddling a read boundary — the \r ends this chunk and the
		//    \n starts the next. So trailing CRs are held, not split on, until we
		//    have seen the byte that follows them.
		const held = /\r+$/.exec(this.pending);
		const body = held ? this.pending.slice(0, -held[0].length) : this.pending;
		const parts = body.split(/\r*\n|\r/);
		this.pending = parts.pop() + (held ? held[0] : "");
		for (const line of parts) this.#emit(line, false);

		clearTimeout(this.partialTimer);
		if (this.pending.length) {
			this.partialTimer = setTimeout(() => {
				if (!this.pending.length) return;
				// a held CR that never got its LF is a terminator after all
				const p = this.pending.replace(/\r+$/, "");
				this.pending = "";
				this.#emit(p, true);
			}, PARTIAL_FLUSH_MS);
		}
	}

	#emit(raw, partial) {
		if (!raw.length && !partial) {
			// Keep blank lines — they carry visual structure in boot banners —
			// but collapse runs of them. Devices emit a lot of bare CRs.
			if (this.lastWasBlank) return;
			this.lastWasBlank = true;
		} else {
			this.lastWasBlank = false;
		}
		const p = this.parse(raw);
		this.store.addLine({ src: this.name, ...p, partial });
		this.lines++;
	}

	/* ── raw mode ────────────────────────────────────────────────────────
	 *
	 * A binary protocol (XMODEM) cannot go through the line splitter: framing
	 * bytes are not text, and a 250 KB transfer would otherwise be shredded into
	 * tens of thousands of garbage "log lines". Raw mode diverts the byte stream
	 * to a single consumer, which decides what — if anything — to put in the log.
	 *
	 * Only one consumer at a time, and it MUST release, so acquire/release is
	 * always paired with try/finally by callers.
	 */

	acquireRaw() {
		if (this.rawMode) throw new Error(`${this.name} is already in raw mode`);
		if (!this.connected) throw new Error(`${this.name} is not connected`);
		// Anything already half-parsed belongs to the text world; drop it.
		clearTimeout(this.partialTimer);
		this.pending = "";
		this.rawMode = true;
		this.rawBuf = Buffer.alloc(0);
		this.rawWaiter = null;
		return this;
	}

	releaseRaw() {
		this.rawMode = false;
		this.rawBuf = Buffer.alloc(0);
		if (this.rawWaiter) {
			const w = this.rawWaiter;
			this.rawWaiter = null;
			clearTimeout(w.timer);
			w.resolve(null);
		}
	}

	#rawPush(chunk) {
		this.lastAt = Date.now();
		this.rawBuf = this.rawBuf.length ? Buffer.concat([this.rawBuf, chunk]) : chunk;
		const w = this.rawWaiter;
		if (!w) return;
		if (this.rawBuf.length < w.need) return;
		this.rawWaiter = null;
		clearTimeout(w.timer);
		const out = this.rawBuf.subarray(0, w.need);
		this.rawBuf = this.rawBuf.subarray(w.need);
		w.resolve(Buffer.from(out));
	}

	/** Read exactly `need` bytes, or null on timeout. */
	rawRead(need, timeoutMs) {
		if (this.rawBuf.length >= need) {
			const out = Buffer.from(this.rawBuf.subarray(0, need));
			this.rawBuf = this.rawBuf.subarray(need);
			return Promise.resolve(out);
		}
		if (this.rawWaiter) return Promise.reject(new Error("concurrent rawRead"));
		return new Promise((resolve) => {
			const w = { need, resolve };
			w.timer = setTimeout(() => {
				if (this.rawWaiter === w) this.rawWaiter = null;
				resolve(null);
			}, timeoutMs);
			this.rawWaiter = w;
		});
	}

	/** Drain and discard whatever has already arrived. */
	rawFlush() {
		const n = this.rawBuf.length;
		this.rawBuf = Buffer.alloc(0);
		return n;
	}

	/**
	 * Accumulate text until `needle` appears. `onText` receives each decoded
	 * chunk so the caller can mirror the dialogue into the log as it happens —
	 * a bootloader handshake is exactly the part worth having a record of.
	 */
	async rawReadUntil(needle, timeoutMs, onText) {
		const deadline = Date.now() + timeoutMs;
		let acc = "";
		for (;;) {
			const left = deadline - Date.now();
			if (left <= 0) return { ok: false, text: acc };
			const b = await this.rawRead(1, Math.min(left, 250));
			if (!b) continue;
			// Take everything buffered alongside that byte in one go.
			const more = this.rawBuf;
			this.rawBuf = Buffer.alloc(0);
			const text = Buffer.concat([b, more]).toString("utf8");
			acc += text;
			if (onText) onText(text);
			if (acc.includes(needle)) return { ok: true, text: acc };
			if (acc.length > 65536) acc = acc.slice(-needle.length - 512);
		}
	}

	/**
	 * Write, tolerating a full tty output buffer. A non-blocking fd can accept a
	 * partial write or refuse outright with EAGAIN; either would silently
	 * truncate a command, so drain the remainder with a short backoff.
	 */
	write(data) {
		if (!this.connected || this.fd == null) {
			throw new Error(`port ${this.name} is not connected`);
		}
		let b = Buffer.from(data, "utf8");
		const deadline = Date.now() + 5000;
		while (b.length) {
			let n = 0;
			try {
				n = fs.writeSync(this.fd, b);
			} catch (err) {
				if (err.code !== "EAGAIN") throw err;
				if (Date.now() > deadline) throw new Error(`write to ${this.name} timed out`);
				sleepSync(10);
				continue;
			}
			b = b.subarray(n);
		}
	}

	#drop(err) {
		clearTimeout(this.timer);
		clearTimeout(this.partialTimer);
		this.lastError = String(err?.message ?? err);
		if (this.connected) {
			this.store.addAnnotation({
				kind: "error",
				author: "system",
				text: `${this.name} disconnected: ${err?.message ?? err}`,
				meta: { port: this.name },
			});
		}
		this.connected = false;
		try {
			if (this.fd != null) fs.closeSync(this.fd);
		} catch {}
		this.fd = null;
		if (this.stopped) return;
		setTimeout(() => this.#open(), this.retryMs);
		this.retryMs = Math.min(this.retryMs * 2, 10_000);
	}

	stop() {
		this.stopped = true;
		clearTimeout(this.timer);
		clearTimeout(this.partialTimer);
		try {
			if (this.fd != null) fs.closeSync(this.fd);
		} catch {}
		this.fd = null;
		this.connected = false;
	}

	status() {
		return {
			name: this.name,
			device: this.device,
			type: "serial",
			baud: this.baud,
			connected: this.connected,
			lines: this.lines,
			lastAt: this.lastAt,
			writable: true,
		};
	}
}
