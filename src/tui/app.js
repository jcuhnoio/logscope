// logscope TUI: the human's view of a running daemon.
//
// Rendering is pull-based and throttled. Stream events only mutate the model
// and mark the frame dirty; at most FRAME_MS later one frame is laid out from
// the rows that are actually on screen and drawn as a cell diff. A burst of
// 50k lines therefore costs 50k array pushes and a handful of frames, not
// 50k redraws — which is what made the browser UI fall over.

import termkit from "terminal-kit";
import { LogModel, LEVELS } from "./model.js";
import { layout, rowHeight, strWidth, srcColor, authorStyle } from "./format.js";
import { makeApi, openStream } from "./client.js";

const FRAME_MS = 33;
const BACKLOG = 20_000; // lines replayed from the daemon on connect
const RATE_WINDOW = 5; // seconds
const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const HIGHLIGHT_MS = 1500;
const MSG_MS = 4000;

const STYLES = {
	base: {},
	bar: { color: 252, bgColor: 236 },
	barDim: { color: 245, bgColor: 236 },
	barKey: { color: 222, bgColor: 236, bold: true },
	live: { color: 114, bgColor: 236, bold: true },
	down: { color: 203, bgColor: 236, bold: true },
	time: { color: 244 },
	seq: { color: 240 },
	lvlErr: { color: 203, bold: true },
	lvlWrn: { color: 214 },
	lvlInf: { color: 71 },
	lvlDbg: { color: 243 },
	tag: { color: 110 },
	msg: {},
	msgErr: { color: 210 },
	msgWrn: { color: 222 },
	msgDbg: { color: 246 },
	mark: { color: 179 },
	kAnalysis: { color: 141 },
	kNote: { color: 75 },
	kError: { color: 203 },
	kCommand: { color: 214 },
	kRun: { color: 114 },
	byUser: { color: 117, italic: true },
	byAgent: { color: 141, italic: true },
	bySystem: { color: 244, italic: true },
	annText: {},
	ok: { color: 114 },
	bad: { color: 203 },
	dim: { color: 244 },
	sep: { color: 238 },
	sel: { bgColor: 238 },
	hl: { bgColor: 58 },
	err: { color: 203, bold: true },
	box: { color: 250, bgColor: 235 },
	boxSel: { color: 255, bgColor: 25, bold: true },
	boxDim: { color: 243, bgColor: 235 },
};

export async function runTui({ base }) {
	const term = termkit.terminal;
	const api = makeApi(base);

	// ---- state -------------------------------------------------------------

	let model = new LogModel();
	const st = {
		session: null,
		status: null,
		conn: "connecting",
		connWhy: "",
		follow: true,
		anchor: null, // row at the bottom of the log pane when not following
		wrap: false,
		showAnns: true,
		focus: "log", // "log" | "anns"
		annSel: -1, // index into model.anns; -1 = follow newest
		mode: "normal", // "normal" | "filter" | "send" | "jump"
		input: { text: "", cur: 0 },
		sendHist: [],
		histIdx: 0,
		sendPort: null,
		baud: 115200,
		picker: null,
		help: false,
		mouse: false,
		highlight: null, // { row, until }
		msg: null, // { text, err, until }
		rate: new Array(RATE_WINDOW).fill(0),
		rateNow: 0,
		startFrom: 0,
	};

	// ---- screen + styles ----------------------------------------------------

	let sb = null;
	const attrCache = new Map();
	const attr = (st_) => {
		if (st_ == null) return attr("base");
		const key = typeof st_ === "string" ? st_ : JSON.stringify(st_);
		let a = attrCache.get(key);
		if (a === undefined) {
			// object2attr mutates its argument; hand it a copy.
			a = sb.object2attr({ ...(typeof st_ === "string" ? STYLES[st_] : st_) });
			attrCache.set(key, a);
		}
		return a;
	};
	const withBg = (st_, bg) => {
		const o = typeof st_ === "string" ? STYLES[st_] : (st_ ?? {});
		return { ...o, ...STYLES[bg] };
	};

	function makeBuffer() {
		sb = termkit.ScreenBuffer.create({ dst: term, width: term.width, height: term.height });
		attrCache.clear();
	}

	/** Put segments at (x, y), truncated to `maxW` cells. Returns cells used. */
	function putSegs(x, y, segs, maxW, bg) {
		let used = 0;
		for (const seg of segs) {
			if (used >= maxW) break;
			let s = seg.s;
			const w = strWidth(s);
			if (used + w > maxW) {
				let out = "";
				let ow = 0;
				for (const ch of s) {
					const cw = strWidth(ch);
					if (used + ow + cw > maxW) break;
					out += ch;
					ow += cw;
				}
				s = out;
			}
			const a = attr(bg ? withBg(seg.st, bg) : seg.st);
			sb.put({ x: x + used, y, attr: a, wrap: false }, "%s", s);
			used += strWidth(s);
		}
		if (bg && used < maxW) sb.put({ x: x + used, y, attr: attr(bg), wrap: false }, "%s", " ".repeat(maxW - used));
		return used;
	}

	// ---- geometry ------------------------------------------------------------

	const annPaneW = () => (st.showAnns && term.width >= 80 ? Math.min(48, Math.floor(term.width / 3)) : 0);
	const logW = () => term.width - (annPaneW() ? annPaneW() + 1 : 0);
	const logH = () => Math.max(1, term.height - 3);

	function fmtCtx() {
		const many = model.sources.length > 1;
		return {
			width: logW(),
			wrap: st.wrap,
			seqWidth: Math.max(5, String(model.lastSeq).length),
			srcWidth: many ? Math.min(12, Math.max(...model.sources.map((s) => s.length))) : 0,
		};
	}

	function bottomIndex() {
		const v = model.vis;
		if (!v.length) return -1;
		if (st.follow || !st.anchor) return v.length - 1;
		return model.indexAtOrBefore(st.anchor);
	}

	// ---- rendering -----------------------------------------------------------

	let dirty = true;
	let frameTimer = null;
	let lastFrame = 0;

	function requestRender() {
		dirty = true;
		if (frameTimer) return;
		const wait = Math.max(0, FRAME_MS - (Date.now() - lastFrame));
		frameTimer = setTimeout(() => {
			frameTimer = null;
			if (dirty) render();
		}, wait);
	}

	function render() {
		dirty = false;
		lastFrame = Date.now();
		const now = Date.now();
		if (st.highlight && st.highlight.until < now) st.highlight = null;
		if (st.msg && st.msg.until < now) st.msg = null;

		sb.fill({ char: " ", attr: attr("base") });
		drawTopBar();
		drawLog();
		if (annPaneW()) drawAnnPane();
		drawStatusLine();
		drawPromptLine();
		if (st.picker) drawPicker();
		if (st.help) drawHelp();

		sb.draw({ delta: true });
		placeCursor();
	}

	function drawTopBar() {
		const ports = st.status?.ports ?? [];
		const segs = [{ s: " logscope ", st: "barKey" }];
		if (st.session) segs.push({ s: ` ${st.session} `, st: "barDim" });
		for (const p of ports) {
			const dev = p.type === "serial" ? `${String(p.device).replace(/^\/dev\/(cu\.)?/, "")}@${p.baud}` : p.type;
			segs.push({ s: " " });
			segs.push({ s: p.name, st: { color: srcColor(p.name), bgColor: 236, bold: true } });
			segs.push({ s: ` ${dev}${p.connected ? "" : " ✗"}`, st: p.connected ? "barDim" : "down" });
		}
		if (!ports.length && st.status) segs.push({ s: "  no sources — d to attach a device", st: "barDim" });
		const rate = st.rate.reduce((a, b) => a + b, 0) / RATE_WINDOW;
		const right = [
			{ s: `head ${model.lastSeq}  `, st: "barDim" },
			{ s: `${rate.toFixed(1)}/s  `, st: "barDim" },
			st.conn === "live" ? { s: "● live ", st: "live" } : { s: `○ ${st.connWhy || st.conn} `, st: "down" },
		];
		const rw = right.reduce((n, s) => n + strWidth(s.s), 0);
		putSegs(0, 0, segs, Math.max(0, term.width - rw), "bar");
		putSegs(Math.max(0, term.width - rw), 0, right, rw, "bar");
	}

	function drawLog() {
		const h = logH();
		const w = logW();
		const v = model.vis;
		if (!v.length) {
			const why = model.lines.length ? "no lines match the filter" : "waiting for lines…";
			putSegs(2, 1 + Math.floor(h / 2), [{ s: why, st: "dim" }], w - 2);
			return;
		}
		const ctx = fmtCtx();
		const rows = layout(v, bottomIndex(), h, ctx);
		const hl = st.highlight?.row;
		for (let i = 0; i < rows.length; i++) {
			putSegs(0, 1 + i, rows[i].segs, w, rows[i].row === hl ? "hl" : null);
		}
	}

	function drawAnnPane() {
		const pw = annPaneW();
		const x = term.width - pw;
		const h = logH();
		for (let y = 1; y <= h; y++) sb.put({ x: x - 1, y, attr: attr("sep"), wrap: false }, "│");
		const focused = st.focus === "anns";
		const title = [{ s: ` annotations ${model.anns.length} `, st: focused ? "barKey" : "barDim" }];
		putSegs(x, 1, title, pw, "bar");
		const list = model.anns;
		const lh = h - 1;
		const sel = st.annSel < 0 ? list.length - 1 : st.annSel;
		// Keep the selection on screen; default to showing the newest.
		const top = Math.max(0, Math.min(list.length - lh, sel - lh + 1));
		for (let i = 0; i < lh && top + i < list.length; i++) {
			const r = list[top + i];
			const a = r.data;
			const isSel = focused && top + i === sel;
			const kindSt = a.kind === "mark" ? "mark" : (a.kind === "run" ? "kRun" : a.kind === "error" ? "kError" : a.kind === "command" ? "kCommand" : a.kind === "analysis" ? "kAnalysis" : "kNote");
			const text = String(
				a.kind === "mark" ? `── ${a.meta?.label || a.text}` : a.kind === "command" && a.meta?.data === "" ? "→ ⏎" : a.text ?? ""
			).replace(/\s+/g, " ");
			const segs = [
				{ s: String(r.seq).padStart(6) + " ", st: "seq" },
				{ s: "▍", st: kindSt },
				{ s: text, st: a.kind === "mark" ? "mark" : authorStyle(a.author) === "byUser" ? "byUser" : "annText" },
			];
			putSegs(x, 2 + i, segs, pw, isSel ? "sel" : null);
		}
	}

	function drawStatusLine() {
		const y = term.height - 2;
		const segs = [];
		if (st.msg) {
			segs.push({ s: " " + st.msg.text, st: st.msg.err ? "err" : "ok" });
			putSegs(0, y, segs, term.width, "bar");
			return;
		}
		segs.push({ s: " " });
		for (const l of LEVELS) {
			const on = !model.lvlOff.has(l);
			segs.push({ s: l, st: on ? { color: { err: 203, wrn: 214, inf: 71, dbg: 245 }[l], bgColor: 236, bold: true } : { color: 239, bgColor: 236, strike: true } });
			segs.push({ s: " " });
		}
		if (model.sources.length > 1) {
			segs.push({ s: "│ ", st: "barDim" });
			for (const s of model.sources) {
				const on = !model.srcOff.has(s);
				segs.push({ s, st: on ? { color: srcColor(s), bgColor: 236 } : { color: 239, bgColor: 236, strike: true } });
				segs.push({ s: " " });
			}
		}
		if (model.filterRaw) {
			segs.push({ s: "│ ", st: "barDim" });
			segs.push({ s: `/${model.filterRaw}`, st: model.filterErr ? "down" : "barKey" });
			segs.push({ s: " " });
		}
		if (st.wrap) segs.push({ s: "│ wrap ", st: "barDim" });
		const right = [];
		right.push({ s: `${model.visLines} of ${model.lines.length} `, st: "barDim" });
		if (!st.follow) {
			const behind = model.vis.length - 1 - bottomIndex();
			right.push({ s: behind > 0 ? ` ↓ ${behind} more — G to follow ` : " paused — G to follow ", st: "barKey" });
		}
		const rw = right.reduce((n, s) => n + strWidth(s.s), 0);
		putSegs(0, y, segs, Math.max(0, term.width - rw), "bar");
		putSegs(Math.max(0, term.width - rw), y, right, rw, "bar");
	}

	function promptLabel() {
		if (st.mode === "filter") return { s: "filter / ", st: "barKey" };
		if (st.mode === "jump") return { s: "jump to seq # ", st: "barKey" };
		if (st.mode === "send") return { s: `send → ${st.sendPort ?? "?"} > `, st: { color: srcColor(st.sendPort), bold: true } };
		return null;
	}

	function drawPromptLine() {
		const y = term.height - 1;
		const label = promptLabel();
		if (label) {
			const w = putSegs(0, y, [label], term.width);
			putSegs(w, y, [{ s: st.input.text }], term.width - w);
			if (st.mode === "send") {
				const hint = "  ⏎ send (empty = newline) · tab: port · esc: close";
				const used = w + strWidth(st.input.text);
				if (used + strWidth(hint) < term.width) putSegs(term.width - strWidth(hint), y, [{ s: hint, st: "dim" }], strWidth(hint));
			}
			return;
		}
		const keys = [["/", "filter"], [":", "send"], ["d", "device"], ["b", "baud"], ["1-4", "levels"], ["s", "sources"], ["a", "annotations"], ["w", "wrap"], ["?", "help"], ["q", "quit"]];
		const segs = [];
		for (const [k, what] of keys) segs.push({ s: ` ${k}`, st: "barKey" }, { s: ` ${what} `, st: "dim" });
		putSegs(0, y, segs, term.width);
	}

	function placeCursor() {
		const label = promptLabel();
		if (label && !st.picker && !st.help) {
			const before = st.input.text.slice(0, st.input.cur);
			term.moveTo(1 + strWidth(label.s) + strWidth(before), term.height);
			term.hideCursor(false);
		} else {
			term.hideCursor(true);
		}
	}

	function box(title, lines, selIdx, width, footer = "") {
		const w = Math.min(term.width - 4, Math.max(width, strWidth(title) + 4));
		const h = Math.min(term.height - 4, lines.length + 2);
		const x = Math.floor((term.width - w) / 2);
		const y = Math.floor((term.height - h) / 2);
		putSegs(x, y, [{ s: ` ${title} `, st: { ...STYLES.box, bold: true } }], w, "box");
		const inner = h - 2;
		const top = Math.max(0, Math.min(lines.length - inner, (selIdx ?? 0) - inner + 1));
		for (let i = 0; i < inner; i++) {
			const ln = lines[top + i];
			const isSel = selIdx === top + i;
			putSegs(x, y + 1 + i, ln ? [{ s: "  " }, ...ln] : [], w, isSel ? "boxSel" : "box");
		}
		putSegs(x, y + h - 1, [{ s: footer ? `  ${footer}` : "", st: "boxDim" }], w, "box");
	}

	function drawPicker() {
		const p = st.picker;
		const lines = p.items.map((it) => it.segs.map((s) => ({ ...s, st: s.st ?? (it.disabled ? "boxDim" : "box") })));
		if (!lines.length) lines.push([{ s: p.empty ?? "nothing here", st: "boxDim" }]);
		box(p.title, lines, p.items.length ? p.sel : null, p.width ?? 64, `⏎ ${p.verb ?? "select"} · esc close`);
	}

	function drawHelp() {
		const K = (k, d) => [{ s: k.padEnd(14), st: { ...STYLES.box, color: 222, bold: true } }, { s: d }];
		const lines = [
			K("↑ ↓ j k", "scroll a row (wheel scrolls too, in most terminals)"),
			K("PgUp PgDn", "scroll a page (space pages down)"),
			K("g  G / End", "top · bottom and follow"),
			K("/", "filter: plain text or /regex/ — esc clears"),
			K("1 2 3 4", "toggle err · wrn · inf · dbg"),
			K("s", "toggle sources"),
			K("#", "jump to a seq"),
			K(": or i", "send to device — empty line sends a newline"),
			K("d", "attach / detach serial devices (saved to config)"),
			K("b", "baud rate (saved to config)"),
			K("a", "show / hide the annotation list"),
			K("tab", "focus the annotation list — ⏎ jumps to it"),
			K("w", "wrap long lines"),
			K("C", "clear the view (history stays on the daemon)"),
			K("m", "capture the mouse (wheel) — off keeps text selectable"),
			K("q  ctrl-c", "quit — the daemon keeps running"),
		];
		box("keys  (any key closes)", lines, null, 72);
	}

	// ---- messages -------------------------------------------------------------

	function say(text, err = false) {
		st.msg = { text, err, until: Date.now() + MSG_MS };
		requestRender();
		setTimeout(requestRender, MSG_MS + 50);
	}

	// ---- scrolling ------------------------------------------------------------

	function scrollTo(idx) {
		const v = model.vis;
		if (!v.length) return;
		if (idx >= v.length - 1) {
			st.follow = true;
			st.anchor = null;
		} else {
			st.follow = false;
			st.anchor = v[Math.max(0, idx)];
		}
		requestRender();
	}

	function scrollRows(n) {
		const i = bottomIndex();
		if (i < 0) return;
		// When content above is shorter than a screen, the anchor sits below
		// what's visible; scrolling up from there should move immediately.
		scrollTo(i + n);
	}

	function page(dir) {
		const i = bottomIndex();
		if (i < 0) return;
		const ctx = fmtCtx();
		let rows = 0;
		let j = i;
		const target = logH() - 1;
		if (dir < 0) {
			while (j > 0 && rows < target) rows += rowHeight(model.vis[j--], ctx);
		} else {
			while (j < model.vis.length - 1 && rows < target) rows += rowHeight(model.vis[++j], ctx);
		}
		scrollTo(j);
	}

	/** Put `row` around the middle of the log pane and flash it. */
	function reveal(row) {
		const v = model.vis;
		let i = model.indexAtOrBefore(row);
		if (!v.length) return;
		const ctx = fmtCtx();
		let rows = 0;
		const half = Math.floor(logH() / 2);
		while (i < v.length - 1 && rows < half) rows += rowHeight(v[++i], ctx);
		scrollTo(i);
		const hit = v[model.indexAtOrBefore(row)];
		st.highlight = { row: hit, until: Date.now() + HIGHLIGHT_MS };
		setTimeout(requestRender, HIGHLIGHT_MS + 50);
	}

	// ---- line editing ---------------------------------------------------------

	function openInput(mode, text = "") {
		st.mode = mode;
		st.input = { text, cur: text.length };
		requestRender();
	}

	function closeInput() {
		st.mode = "normal";
		requestRender();
	}

	/** Shared single-line editor. Returns true if the key was consumed. */
	function editKey(name, data) {
		const t = st.input;
		const at = (s) => {
			t.text = t.text.slice(0, t.cur) + s + t.text.slice(t.cur);
			t.cur += s.length;
		};
		switch (name) {
			case "BACKSPACE":
				if (t.cur > 0) {
					const prev = [...t.text.slice(0, t.cur)].pop();
					t.text = t.text.slice(0, t.cur - prev.length) + t.text.slice(t.cur);
					t.cur -= prev.length;
				}
				return true;
			case "DELETE":
				if (t.cur < t.text.length) {
					const next = [...t.text.slice(t.cur)][0];
					t.text = t.text.slice(0, t.cur) + t.text.slice(t.cur + next.length);
				}
				return true;
			case "LEFT":
				if (t.cur > 0) t.cur -= [...t.text.slice(0, t.cur)].pop().length;
				return true;
			case "RIGHT":
				if (t.cur < t.text.length) t.cur += [...t.text.slice(t.cur)][0].length;
				return true;
			case "HOME":
			case "CTRL_A":
				t.cur = 0;
				return true;
			case "END":
			case "CTRL_E":
				t.cur = t.text.length;
				return true;
			case "CTRL_U":
				t.text = t.text.slice(t.cur);
				t.cur = 0;
				return true;
			case "CTRL_W": {
				const left = t.text.slice(0, t.cur).replace(/\S+\s*$/, "");
				t.text = left + t.text.slice(t.cur);
				t.cur = left.length;
				return true;
			}
		}
		if (data?.isCharacter) {
			at(name);
			return true;
		}
		return false;
	}

	// ---- actions ----------------------------------------------------------------

	const writablePorts = () => (st.status?.ports ?? []).filter((p) => p.writable && p.connected !== false);
	const serialPorts = () => (st.status?.ports ?? []).filter((p) => p.type === "serial" && p.device);

	function openSend() {
		const ports = writablePorts();
		if (!ports.length) return say("no writable source attached — d to attach a device", true);
		if (!ports.some((p) => p.name === st.sendPort)) st.sendPort = ports[0].name;
		st.histIdx = st.sendHist.length;
		openInput("send");
	}

	async function doSend() {
		const data = st.input.text;
		const port = st.sendPort;
		// Empty is a real command: a bare newline wakes a shell prompt or
		// confirms a bootloader menu.
		if (data && st.sendHist[st.sendHist.length - 1] !== data) st.sendHist.push(data);
		st.histIdx = st.sendHist.length;
		st.input = { text: "", cur: 0 };
		st.follow = true;
		requestRender();
		try {
			// No `newline`: the daemon applies the source's configured eol.
			await api("/api/send", { port, data, annotate: true, author: "user" });
		} catch (err) {
			st.input = { text: data, cur: data.length };
			say(`send failed: ${err.message}`, true);
		}
	}

	const unsaved = (r) => (r.saved === false ? " — but config.json could not be updated" : "");

	function applyPorts(r) {
		if (r?.ports && st.status) st.status = { ...st.status, ports: r.ports };
	}

	async function openDevicePicker() {
		// The scan asks lsof who holds each port, which takes a second or so;
		// open the box now so the key press visibly did something.
		const title = `serial devices — new attaches at ${st.baud}`;
		const picker = { title, verb: "attach / detach", empty: "scanning…", items: [], sel: 0, onPick: () => {} };
		st.picker = picker;
		requestRender();
		let devices;
		try {
			({ devices } = await api("/api/devices"));
		} catch (err) {
			if (st.picker === picker) st.picker = null;
			return say(`devices: ${err.message}`, true);
		}
		if (st.picker !== picker) return; // closed while scanning
		const items = devices.map((d) => {
			const on = !!d.attachedAs;
			const busy = d.heldBy && !on;
			const name = d.attachedAs || d.configuredAs;
			const port = (st.status?.ports ?? []).find((p) => p.name === d.attachedAs);
			const segs = [
				{ s: on ? "● " : "○ ", st: on ? { ...STYLES.box, color: 114 } : undefined },
				{ s: d.label.padEnd(28) },
			];
			if (name) segs.push({ s: ` ${name}`, st: { ...STYLES.box, color: srcColor(name), bold: true } });
			if (port?.baud) segs.push({ s: ` @${port.baud}` });
			if (busy) segs.push({ s: `  busy: ${d.heldBy}`, st: { ...STYLES.box, color: 203 } });
			else if (!d.likely && !on) segs.push({ s: "  bluetooth?", st: "boxDim" });
			return { segs, value: d, disabled: busy };
		});
		Object.assign(picker, {
			empty: "no serial devices found",
			items,
			sel: Math.max(0, items.findIndex((i) => !i.disabled)),
			onPick: (it) => toggleDevice(it.value),
		});
		requestRender();
	}

	async function toggleDevice(d) {
		if (d.heldBy && !d.attachedAs) return say(`${d.label} is held by ${d.heldBy}`, true);
		st.picker = null;
		try {
			if (d.attachedAs) {
				const r = await api("/api/detach", { name: d.attachedAs, author: "user" });
				applyPorts(r);
				say(`detached ${d.attachedAs}${unsaved(r)}`, r.saved === false);
			} else {
				const name = d.configuredAs || d.label.replace(/[^\w.-]+/g, "-");
				say(`opening ${d.label} @ ${st.baud}…`);
				const r = await api("/api/attach", { name, device: d.device, baud: st.baud, author: "user" });
				applyPorts(r);
				say(`attached ${name} → ${d.label} @ ${st.baud}${unsaved(r)}`, r.saved === false);
			}
		} catch (err) {
			say(err.message, true);
		}
	}

	function openBaudPicker(port) {
		const serial = serialPorts();
		if (!port && serial.length > 1) {
			st.picker = {
				title: "change baud for which port?",
				items: serial.map((p) => ({ segs: [{ s: `${p.name}`, st: { ...STYLES.box, color: srcColor(p.name), bold: true } }, { s: `  ${p.device} @ ${p.baud}` }], value: p })),
				sel: 0,
				onPick: (it) => openBaudPicker(it.value),
			};
			return requestRender();
		}
		const target = port ?? serial[0] ?? null;
		const cur = target?.baud ?? st.baud;
		st.picker = {
			title: target ? `baud for ${target.name}` : "baud for the next attach",
			width: 40,
			items: BAUDS.map((b) => ({ segs: [{ s: b === cur ? "● " : "  " }, { s: String(b) }], value: b })),
			sel: Math.max(0, BAUDS.indexOf(cur)),
			onPick: (it) => setBaud(target, it.value),
		};
		requestRender();
	}

	async function setBaud(port, baud) {
		st.picker = null;
		st.baud = baud;
		if (!port) return say(`next attach will use ${baud}`);
		try {
			// Re-attaching the same device at a new rate; the daemon persists it.
			const r = await api("/api/attach", { name: port.name, device: port.device, baud, author: "user" });
			applyPorts(r);
			say(`${port.name} @ ${baud}${unsaved(r)}`, r.saved === false);
		} catch (err) {
			say(err.message, true);
		}
	}

	function openSourcePicker() {
		const build = () =>
			model.sources.map((s) => ({
				segs: [{ s: model.srcOff.has(s) ? "[ ] " : "[x] " }, { s, st: { ...STYLES.box, color: srcColor(s), bold: true } }],
				value: s,
			}));
		st.picker = {
			title: "sources",
			verb: "toggle",
			width: 40,
			empty: "no sources seen yet",
			items: build(),
			sel: 0,
			keepOpen: true,
			onPick: (it) => {
				model.toggleSource(it.value);
				st.picker.items = build();
			},
		};
		requestRender();
	}

	function jumpToSeq(seq) {
		if (!Number.isFinite(seq)) return say("not a number", true);
		if (seq <= model.floor || (model.lines.length && seq < model.lines[0].seq)) {
			return say(`#${seq} is older than this view holds — try logscope tail --since ${Math.max(0, seq - 1)}`, true);
		}
		const row = model.lines.find((r) => r.seq >= seq);
		if (!row) return say(`#${seq} hasn't happened yet`, true);
		reveal(row);
	}

	// ---- keys ---------------------------------------------------------------

	function onKey(name, _matches, data) {
		if (name === "CTRL_C") return quit();

		// Esc followed quickly by a key arrives as one Alt chord. Nothing here
		// binds Alt, so it always meant "Esc, then that key" — and dropping
		// the Esc would leave a picker open for the next key to act on.
		const alt = /^ALT_(SHIFT_)?(.)$/.exec(name);
		if (alt) {
			onKey("ESCAPE", [], {});
			const ch = alt[1] ? alt[2] : alt[2].toLowerCase();
			return onKey(ch, [], { isCharacter: true });
		}

		if (st.help) {
			st.help = false;
			return requestRender();
		}

		if (st.picker) return pickerKey(name);

		if (st.mode !== "normal") return inputKey(name, data);

		if (st.focus === "anns" && annKey(name)) return;

		switch (name) {
			case "q":
				return quit();
			case "UP":
			case "k":
				return scrollRows(-1);
			case "DOWN":
			case "j":
				return scrollRows(1);
			case "PAGE_UP":
				return page(-1);
			case "b":
				return openBaudPicker();
			case "PAGE_DOWN":
			case " ":
				return page(1);
			case "g":
			case "HOME":
				return scrollTo(0);
			case "G":
			case "END":
				return scrollTo(Infinity);
			case "/":
				return openInput("filter", model.filterRaw);
			case ":":
			case "i":
				return openSend();
			case "#":
				return openInput("jump");
			case "d":
				return void openDevicePicker();
			case "s":
				return openSourcePicker();
			case "a":
				st.showAnns = !st.showAnns;
				if (!st.showAnns) st.focus = "log";
				return requestRender();
			case "TAB":
				if (!annPaneW()) st.showAnns = true;
				st.focus = st.focus === "anns" ? "log" : "anns";
				return requestRender();
			case "w":
				st.wrap = !st.wrap;
				return requestRender();
			case "C":
				model.clear();
				st.follow = true;
				return requestRender();
			case "m":
				st.mouse = !st.mouse;
				term.grabInput(st.mouse ? { mouse: "button" } : true);
				return say(st.mouse ? "mouse captured — wheel scrolls; shift-drag to select text" : "mouse released — text is selectable");
			case "CTRL_L":
				term.clear();
				makeBuffer();
				return requestRender();
			case "?":
				st.help = true;
				return requestRender();
			case "ESCAPE":
				if (model.filterRaw) {
					model.setFilter("");
					return requestRender();
				}
				return;
		}
		const lvl = { 1: "err", 2: "wrn", 3: "inf", 4: "dbg" }[name];
		if (lvl) {
			model.toggleLevel(lvl);
			requestRender();
		}
	}

	function annKey(name) {
		const n = model.anns.length;
		const cur = st.annSel < 0 ? n - 1 : st.annSel;
		const set = (i) => {
			st.annSel = i >= n - 1 ? -1 : Math.max(0, i);
			requestRender();
		};
		switch (name) {
			case "UP":
			case "k":
				set(cur - 1);
				return true;
			case "DOWN":
			case "j":
				set(cur + 1);
				return true;
			case "PAGE_UP":
				set(cur - (logH() - 2));
				return true;
			case "PAGE_DOWN":
				set(cur + (logH() - 2));
				return true;
			case "g":
			case "HOME":
				set(0);
				return true;
			case "G":
			case "END":
				set(n);
				return true;
			case "ENTER": {
				const r = model.anns[cur];
				if (!r) return true;
				if (r.seq <= model.floor && model.floor > 0) say(`#${r.seq} is older than this view holds`, true);
				else reveal(r);
				return true;
			}
			case "ESCAPE":
				st.focus = "log";
				requestRender();
				return true;
		}
		return false;
	}

	function pickerKey(name) {
		const p = st.picker;
		const n = p.items.length;
		const step = (d) => {
			if (!n) return;
			let i = p.sel;
			for (let k = 0; k < n; k++) {
				i = (i + d + n) % n;
				if (!p.items[i].disabled) break;
			}
			p.sel = i;
		};
		switch (name) {
			case "ESCAPE":
			case "q":
				st.picker = null;
				break;
			case "UP":
			case "k":
				step(-1);
				break;
			case "DOWN":
			case "j":
			case "TAB":
				step(1);
				break;
			case " ":
				// Space only toggles in checklists. In the device and baud
				// pickers it would open hardware on a stray keypress.
				if (!p.keepOpen) break;
			// fallthrough
			case "ENTER": {
				const it = p.items[p.sel];
				if (it && !it.disabled) {
					if (!p.keepOpen) st.picker = null;
					p.onPick(it);
				}
				break;
			}
		}
		requestRender();
	}

	function inputKey(name, data) {
		const mode = st.mode;
		if (name === "ESCAPE") {
			// Esc in the filter prompt means "never mind": drop the filter.
			if (mode === "filter") model.setFilter("");
			return closeInput();
		}
		if (name === "ENTER") {
			if (mode === "filter") return closeInput();
			if (mode === "jump") {
				const seq = Number(st.input.text.trim());
				closeInput();
				return jumpToSeq(seq);
			}
			if (mode === "send") return void doSend();
		}
		if (mode === "send") {
			if (name === "TAB") {
				const ports = writablePorts();
				const i = ports.findIndex((p) => p.name === st.sendPort);
				if (ports.length) st.sendPort = ports[(i + 1) % ports.length].name;
				return requestRender();
			}
			if (name === "UP" || name === "DOWN") {
				const h = st.sendHist;
				if (!h.length) return;
				st.histIdx = Math.max(0, Math.min(h.length, st.histIdx + (name === "UP" ? -1 : 1)));
				const t = st.histIdx >= h.length ? "" : h[st.histIdx];
				st.input = { text: t, cur: t.length };
				return requestRender();
			}
		}
		if (editKey(name, data)) {
			if (mode === "filter") model.setFilter(st.input.text);
			requestRender();
		}
	}

	function onMouse(name) {
		if (name === "MOUSE_WHEEL_UP") scrollRows(-3);
		else if (name === "MOUSE_WHEEL_DOWN") scrollRows(3);
	}

	// ---- data ---------------------------------------------------------------

	let stream = null;

	function onEvent(name, data) {
		if (name === "line") {
			if (model.addLine(data)) st.rateNow++;
		} else if (name === "annotation") {
			model.addAnnotation(data);
		} else if (name === "status") {
			if (st.session && data.sessionId !== st.session) return resetSession(data);
			st.session = data.sessionId;
			st.status = data;
			const serial = serialPorts();
			if (serial.length === 1 && serial[0].baud) st.baud = serial[0].baud;
		} else {
			return; // ping
		}
		requestRender();
	}

	async function loadAnnotations() {
		try {
			const { annotations } = await api("/api/annotations?from=0");
			for (const a of annotations) model.addAnnotation(a);
			requestRender();
		} catch {
			// The stream replays annotations in its window anyway.
		}
	}

	function startStream(from) {
		st.startFrom = from;
		stream?.close();
		stream = openStream(base, {
			// Resume after the last line we hold; before any arrive, replay the
			// backlog window.
			cursor: () => (model.lastSeq ? model.lastSeq : st.startFrom),
			onEvent,
			onState: (s, why) => {
				st.conn = s;
				st.connWhy = why ?? "";
				requestRender();
			},
		});
	}

	/** The daemon restarted: seqs start over, so the buffer means nothing now. */
	function resetSession(status) {
		model = new LogModel();
		st.follow = true;
		st.anchor = null;
		st.annSel = -1;
		st.highlight = null;
		st.session = status.sessionId;
		st.status = status;
		say(`daemon restarted — new session ${status.sessionId}`);
		startStream(0);
		void loadAnnotations();
	}

	// ---- lifecycle ------------------------------------------------------------

	let rateTimer = null;
	let quitting = false;

	function quit() {
		if (quitting) return;
		quitting = true;
		stream?.close();
		clearInterval(rateTimer);
		clearTimeout(frameTimer);
		term.hideCursor(false);
		term.grabInput(false);
		term.styleReset();
		term.fullscreen(false);
		process.exit(0);
	}

	term.fullscreen(true);
	term.hideCursor(true);
	term.grabInput(true);
	makeBuffer();

	term.on("key", onKey);
	term.on("mouse", onMouse);
	term.on("resize", () => {
		makeBuffer();
		term.clear();
		requestRender();
	});
	process.on("SIGTERM", quit);
	process.on("uncaughtException", (err) => {
		// Leave the terminal usable before reporting, or the trace lands in
		// the alternate screen and vanishes.
		term.grabInput(false);
		term.fullscreen(false);
		console.error(err);
		process.exit(1);
	});

	rateTimer = setInterval(() => {
		st.rate.shift();
		st.rate.push(st.rateNow);
		st.rateNow = 0;
		requestRender();
	}, 1000);

	// Session + head first, so the backlog window is "the last BACKLOG lines".
	let from = 0;
	try {
		const s = await api("/api/status");
		st.session = s.sessionId;
		st.status = s;
		from = Math.max(0, s.head - BACKLOG);
	} catch (err) {
		st.conn = "down";
		st.connWhy = /fetch failed|ECONNREFUSED/.test(`${err.message} ${err.cause?.code ?? ""}`) ? "daemon not running" : err.message;
	}
	startStream(from);
	void loadAnnotations();
	render();
}
