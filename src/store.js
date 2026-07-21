// Session store: in-memory ring for fast queries + append-only JSONL on disk.
//
// Memory is capped so an overnight session can't eat the machine. Queries that
// reach below the in-memory floor stream the JSONL back off disk, so history is
// never actually lost — only slower to reach.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { shapeKey } from "./parse.js";

const MAX_MEM_LINES = 300_000;

export class Store {
	constructor(rootDir) {
		this.root = rootDir; // <project>/.logscope
		this.sessionId = new Date()
			.toISOString()
			.replace(/\.\d+Z$/, "")
			.replace(/:/g, "-");
		this.dir = path.join(rootDir, "sessions", this.sessionId);
		fs.mkdirSync(path.join(this.dir, "runs"), { recursive: true });

		this.startedAt = Date.now();
		this.head = 0; // last assigned seq
		this.floor = 1; // lowest seq still in memory
		this.lines = []; // ring; lines[i].seq === this.floor + i
		this.annotations = [];
		this.annSeq = 0;
		this.subscribers = new Set();
		this.waiters = new Set();

		this.linesFile = fs.createWriteStream(path.join(this.dir, "lines.jsonl"), { flags: "a" });
		this.annFile = fs.createWriteStream(path.join(this.dir, "annotations.jsonl"), { flags: "a" });

		const cur = path.join(rootDir, "current");
		try {
			fs.rmSync(cur, { force: true });
		} catch {}
		try {
			fs.symlinkSync(this.dir, cur, "dir");
		} catch {}
	}

	// ---- ingest ----------------------------------------------------------

	addLine({ src, raw, lvl, tag, msg, dev_ts, partial }) {
		const rec = {
			seq: ++this.head,
			t: Date.now(),
			mono: Date.now() - this.startedAt,
			src,
			raw,
			lvl: lvl ?? null,
			tag: tag ?? null,
			msg: msg ?? raw,
			dev_ts: dev_ts ?? null,
		};
		if (partial) rec.partial = true;

		this.lines.push(rec);
		if (this.lines.length > MAX_MEM_LINES) {
			const drop = this.lines.length - MAX_MEM_LINES;
			this.lines.splice(0, drop);
			this.floor += drop;
		}
		this.linesFile.write(JSON.stringify(rec) + "\n");
		this.#emit("line", rec);
		this.#wake(rec);
		return rec;
	}

	addAnnotation({ seq, kind, author, text, meta }) {
		const rec = {
			id: `a-${++this.annSeq}`,
			seq: seq == null ? this.head : Number(seq),
			t: Date.now(),
			kind: kind || "note",
			author: author || "claude",
			text: text ?? "",
			meta: meta ?? {},
		};
		this.annotations.push(rec);
		this.annFile.write(JSON.stringify(rec) + "\n");
		this.#emit("annotation", rec);
		return rec;
	}

	// ---- queries ---------------------------------------------------------

	#inMem(seq) {
		return seq >= this.floor && seq <= this.head;
	}

	/** Synchronous slice of the in-memory ring. `from` exclusive, `to` inclusive. */
	memSlice(from, to) {
		const lo = Math.max(from + 1, this.floor);
		const hi = Math.min(to ?? this.head, this.head);
		if (hi < lo) return [];
		return this.lines.slice(lo - this.floor, hi - this.floor + 1);
	}

	/**
	 * Full query with disk fallback.
	 * @returns {Promise<{lines:object[], truncated:boolean, fromDisk:boolean}>}
	 */
	async query({ from = 0, to = null, limit = 200, src, grep, flags = "", level, tag, order = "asc" }) {
		limit = Math.min(Math.max(1, limit | 0), 5000);
		const hi = Math.min(to ?? this.head, this.head);
		const re = grep ? new RegExp(grep, flags) : null;
		const levels = level ? new Set(String(level).split(",").map((s) => s.trim())) : null;
		const tags = tag ? new Set(String(tag).split(",").map((s) => s.trim())) : null;

		const match = (l) =>
			(!src || l.src === src) &&
			(!levels || levels.has(l.lvl)) &&
			(!tags || tags.has(l.tag)) &&
			(!re || re.test(l.raw));

		const needDisk = from + 1 < this.floor && this.floor > 1;
		let pool;
		let fromDisk = false;
		if (needDisk) {
			fromDisk = true;
			pool = await this.#diskScan(from, hi, match, order === "desc" ? limit : Infinity);
		} else {
			pool = this.memSlice(from, hi).filter(match);
		}

		const truncated = pool.length > limit;
		const lines = order === "desc" ? pool.slice(-limit) : pool.slice(0, limit);
		if (order === "desc") lines.reverse();
		return { lines, truncated, fromDisk };
	}

	async #diskScan(from, to, match, cap) {
		const out = [];
		const stream = fs.createReadStream(path.join(this.dir, "lines.jsonl"), { encoding: "utf8" });
		const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
		for await (const raw of rl) {
			if (!raw) continue;
			let l;
			try {
				l = JSON.parse(raw);
			} catch {
				continue;
			}
			if (l.seq <= from) continue;
			if (l.seq > to) break;
			if (match(l)) {
				out.push(l);
				if (out.length > cap * 2 && cap !== Infinity) out.shift();
			}
		}
		rl.close();
		stream.destroy();
		return out;
	}

	annotationsIn(from = 0, to = null) {
		const hi = to ?? Infinity;
		// `from` is exclusive like every line cursor, with one carve-out: an
		// annotation made before any line exists anchors at seq 0, and a
		// from-the-top query (from=0) must still deliver it.
		return this.annotations.filter(
			(a) => (a.seq > from || (a.seq === 0 && from <= 0)) && a.seq <= hi
		);
	}

	summary({ since = 0, to = null, src = null }) {
		const hi = Math.min(to ?? this.head, this.head);
		const lo = Math.max(since, this.floor - 1);
		const slice = this.memSlice(lo, hi).filter((l) => !src || l.src === src);

		const byLevel = {};
		const byTag = {};
		const shapes = new Map();
		for (const l of slice) {
			const lv = l.lvl ?? "raw";
			byLevel[lv] = (byLevel[lv] || 0) + 1;
			if (l.tag) byTag[l.tag] = (byTag[l.tag] || 0) + 1;
			if (l.lvl === "err" || l.lvl === "wrn") {
				const k = l.lvl + "|" + shapeKey(l);
				const e = shapes.get(k);
				if (e) {
					e.count++;
					e.lastSeq = l.seq;
				} else {
					shapes.set(k, { seq: l.seq, lastSeq: l.seq, lvl: l.lvl, raw: l.raw, count: 1 });
				}
			}
		}
		const notable = [...shapes.values()].sort((a, b) => b.lastSeq - a.lastSeq).slice(0, 20);
		return {
			range: [lo + 1, hi],
			count: slice.length,
			byLevel,
			byTag,
			notable,
			head: this.head,
			partial: lo > since, // memory floor cut the range short
		};
	}

	// ---- waiting ---------------------------------------------------------

	/**
	 * Resolve as soon as a line at seq > since matches `re`. Scans already-
	 * buffered lines first so a match that landed between calls isn't missed —
	 * that race is the whole reason `since` is a required part of the protocol.
	 */
	wait({ re, src, since, timeout, context = 3, settle = 300 }) {
		const scan = this.memSlice(since, this.head);
		for (const l of scan) {
			if ((!src || l.src === src) && re.test(l.raw)) return this.#resolveMatch(l, context, 0);
		}
		return new Promise((resolve) => {
			const started = Date.now();
			const w = {
				re,
				src,
				context,
				settle,
				resolve: (line) =>
					resolve(this.#resolveMatch(line, context, Date.now() - started, settle)),
				fire: null,
			};
			this.waiters.add(w);
			w.timer = setTimeout(() => {
				this.waiters.delete(w);
				resolve({
					matched: null,
					before: [],
					after: [],
					cursor: this.head,
					elapsed_ms: Date.now() - started,
					timedOut: true,
				});
				// Upper bound is generous on purpose: a firmware download over
				// NB-IoT legitimately runs past 20 minutes, and a wait that
				// expires early looks exactly like a failure.
			}, Math.min(Math.max(timeout | 0, 100), 4 * 60 * 60_000));
		});
	}

	async #resolveMatch(line, context, elapsed, settle = 0) {
		if (settle > 0) await new Promise((r) => setTimeout(r, settle));
		const before = this.memSlice(Math.max(0, line.seq - context - 1), line.seq - 1);
		const after = this.memSlice(line.seq, line.seq + context);
		return { matched: line, before, after, cursor: this.head, elapsed_ms: elapsed, timedOut: false };
	}

	#wake(rec) {
		if (!this.waiters.size) return;
		for (const w of [...this.waiters]) {
			if (w.src && rec.src !== w.src) continue;
			if (!w.re.test(rec.raw)) continue;
			this.waiters.delete(w);
			clearTimeout(w.timer);
			w.resolve(rec);
		}
	}

	// ---- fan-out ---------------------------------------------------------

	subscribe(fn) {
		this.subscribers.add(fn);
		return () => this.subscribers.delete(fn);
	}

	#emit(event, data) {
		for (const fn of this.subscribers) {
			try {
				fn(event, data);
			} catch {}
		}
	}

	/** Resolves once both JSONL streams have flushed to disk. */
	close() {
		return Promise.all([
			new Promise((r) => this.linesFile.end(r)),
			new Promise((r) => this.annFile.end(r)),
		]);
	}
}
