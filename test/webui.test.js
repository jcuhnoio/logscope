// Web client: the Clear button and the annotation range rules around it.
//
// The client is a plain browser module with no exports, so a minimal DOM shim
// is installed before import and the test drives the app the way the browser
// would — SSE events in, DOM out. The shim models only what app.js touches.
import { test } from "node:test";
import assert from "node:assert/strict";

/* ── DOM shim ─────────────────────────────────────────────────────────── */

class FakeEl {
	constructor(tag = "div") {
		this.tagName = String(tag).toUpperCase();
		this.parentNode = null;
		this.children = [];
		this.dataset = {};
		this.style = { setProperty() {} };
		this.hidden = false;
		this.value = "";
		this.textContent = "";
		this.title = "";
		this.className = "";
		this.disabled = false;
		this.options = [];
		this.scrollTop = 0;
		this.scrollHeight = 0;
		this.clientHeight = 0;
		this.offsetHeight = 0;
		this.offsetWidth = 0;
		this.offsetParent = null;
		this._html = "";
		this._listeners = new Map();
		const cls = new Set();
		this.classList = {
			add: (...c) => c.forEach((x) => cls.add(x)),
			remove: (...c) => c.forEach((x) => cls.delete(x)),
			toggle: (c, on) => ((on ?? !cls.has(c)) ? cls.add(c) : cls.delete(c)),
			contains: (c) => cls.has(c),
		};
	}
	get innerHTML() { return this._html; }
	set innerHTML(v) { this._html = String(v); this.children = []; }
	appendChild(c) { c.remove(); c.parentNode = this; this.children.push(c); return c; }
	insertBefore(c, ref) {
		c.remove(); c.parentNode = this;
		const i = this.children.indexOf(ref);
		this.children.splice(i < 0 ? this.children.length : i, 0, c);
		return c;
	}
	remove() {
		if (!this.parentNode) return;
		const i = this.parentNode.children.indexOf(this);
		if (i >= 0) this.parentNode.children.splice(i, 1);
		this.parentNode = null;
	}
	get isConnected() { return this._root || (this.parentNode ? this.parentNode.isConnected : false); }
	after() {}
	replaceWith() {}
	closest() { return null; }
	querySelector() { return new FakeEl(); }
	getBoundingClientRect() { return { left: 0, width: 100 }; }
	focus() {} blur() {} scrollIntoView() {} setSelectionRange() {} setPointerCapture() {}
	addEventListener(t, fn) {
		if (!this._listeners.has(t)) this._listeners.set(t, []);
		this._listeners.get(t).push(fn);
	}
	dispatch(t, ev = {}) {
		for (const fn of this._listeners.get(t) ?? []) {
			fn({ target: this, preventDefault() {}, stopPropagation() {}, ...ev });
		}
	}
}

const registry = new Map();
function getEl(sel) {
	if (!registry.has(sel)) {
		const e = new FakeEl();
		e._root = true;
		registry.set(sel, e);
	}
	return registry.get(sel);
}

class FakeES {
	constructor(url) {
		this.url = url;
		this._listeners = new Map();
		FakeES.last = this;
	}
	addEventListener(t, fn) {
		if (!this._listeners.has(t)) this._listeners.set(t, []);
		this._listeners.get(t).push(fn);
	}
	close() {}
	emit(t, data) {
		for (const fn of this._listeners.get(t) ?? []) fn({ data: JSON.stringify(data) });
	}
}

const API = {
	"/api/status": { sessionId: "test", head: 0, ports: [], project: "/x" },
	"/api/lines": { lines: [], head: 0 },
	"/api/annotations": { annotations: [] },
	"/api/notes": { markdown: "", path: "/x/knowledge.md", mtime: 0 },
	"/api/devices": { devices: [] },
};

const fetchLog = [];

function installShim() {
	globalThis.document = {
		querySelector: getEl,
		querySelectorAll: () => [],
		createElement: (tag) => new FakeEl(tag),
		documentElement: new FakeEl("html"),
		body: new FakeEl("body"),
		activeElement: null,
		addEventListener() {},
	};
	globalThis.window = { addEventListener() {} };
	globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
	globalThis.location = { hash: "", href: "http://local/" };
	globalThis.history = { replaceState() {} };
	globalThis.EventSource = FakeES;
	// synchronous rAF: each enqueue flushes immediately, which keeps the test
	// free of frame-timing waits
	globalThis.requestAnimationFrame = (cb) => (cb(), 0);
	// unref'd so the client's polling loops can't hold the process open
	const realSetInterval = globalThis.setInterval;
	globalThis.setInterval = (fn, ms) => {
		const t = realSetInterval(fn, ms);
		t.unref?.();
		return t;
	};
	globalThis.fetch = async (path, opts) => {
		const key = String(path).split("?")[0];
		fetchLog.push({ path: key, body: opts?.body ? JSON.parse(opts.body) : null });
		return { ok: true, status: 200, text: async () => JSON.stringify(API[key] ?? {}) };
	};
}

const line = (seq) => ({
	seq, t: Date.now(), mono: seq * 10, src: "dev",
	raw: `line ${seq}`, lvl: null, tag: null, msg: `line ${seq}`, dev_ts: null,
});
const ann = (id, seq, text) => ({
	id, seq, t: Date.now(), kind: "note", author: "claude", text, meta: {},
});

/* ── the test ─────────────────────────────────────────────────────────── */

test("clear empties the stream; annotations inline only above the cleared range", async () => {
	installShim();
	await import("../web/app.js");

	// boot() is async — wait until the client opened its stream
	for (let i = 0; i < 200 && !FakeES.last; i++) await new Promise((r) => setTimeout(r, 5));
	const es = FakeES.last;
	assert.ok(es, "client opened its SSE stream");

	const logList = getEl("#logList");
	const annList = getEl("#annList");
	const annCount = getEl("#annCount");

	for (let seq = 1; seq <= 5; seq++) es.emit("line", line(seq));
	es.emit("annotation", ann("a-1", 2, "anchored mid-stream"));
	es.emit("annotation", ann("a-2", 5, "anchored at head"));
	assert.equal(logList.children.length, 7, "5 lines + 2 inline annotations");
	assert.match(annList.innerHTML, /anchored mid-stream/);

	getEl("#clearBtn").dispatch("click");
	assert.equal(logList.children.length, 0, "stream view emptied");
	assert.equal(getEl("#countLabel").textContent, "showing 0 of 0");
	// annotations anchored to cleared lines are cleared with them
	assert.doesNotMatch(annList.innerHTML, /anchored mid-stream/);
	assert.doesNotMatch(annList.innerHTML, /anchored at head/);
	assert.equal(annCount.textContent, "0 / 0");

	// replays from the cleared range (SSE reconnect, gap-fill re-reads ALL
	// annotations) must not repopulate either pane
	es.emit("line", line(4));
	es.emit("annotation", ann("a-1", 2, "anchored mid-stream"));
	assert.equal(logList.children.length, 0);
	assert.doesNotMatch(annList.innerHTML, /anchored mid-stream/);

	// late annotations anchored at or below the cutoff — one inside the range,
	// one exactly at it — are dropped entirely
	es.emit("annotation", ann("a-3", 3, "late, inside cleared range"));
	es.emit("annotation", ann("a-4", 5, "exactly at the cutoff"));
	assert.equal(logList.children.length, 0);
	assert.doesNotMatch(annList.innerHTML, /late, inside cleared range/);
	assert.doesNotMatch(annList.innerHTML, /exactly at the cutoff/);
	assert.equal(annCount.textContent, "0 / 0");

	// traffic above the cutoff flows normally: line + its annotation in the
	// stream, and the annotation in the side list
	es.emit("line", line(6));
	es.emit("annotation", ann("a-5", 6, "after the clear"));
	assert.equal(logList.children.length, 2, "new line + its annotation inlined");
	assert.equal(Number(logList.children[0].dataset.seq), 6);
	assert.match(annList.innerHTML, /after the clear/);
	assert.equal(annCount.textContent, "1 / 1");
});

test("device picker: per-row state, config names, and toggle targets the right port", async () => {
	const tick = () => new Promise((r) => setTimeout(r, 10));
	// runs in the same module instance as the previous test — the app is booted
	const es = FakeES.last;
	assert.ok(es, "app already booted");

	API["/api/devices"] = { devices: [
		{ device: "/dev/cu.usbserial-A", label: "usbserial-A", likely: true,
			attachedAs: "charger", configuredAs: "charger", heldBy: null },
		{ device: "/dev/cu.usbserial-B", label: "usbserial-B", likely: true,
			attachedAs: null, configuredAs: "secc", heldBy: null },
		{ device: "/dev/cu.usbserial-C", label: "usbserial-C", likely: true,
			attachedAs: null, configuredAs: null, heldBy: "tio (pid 6013)" },
	] };

	const devMenu = getEl("#devMenu");
	devMenu.hidden = true;                  // the real element starts [hidden]
	getEl("#devBtn").dispatch("click");     // opens the menu and refreshes
	await tick();

	assert.equal(devMenu.hidden, false);
	// exactly one check mark — only the attached device, not every known one
	assert.equal((devMenu.innerHTML.match(/✓/g) || []).length, 1);
	// config port names are visible on attached and unattached rows alike,
	// tinted with the same srcColor() hue the log pane uses for that port
	assert.match(devMenu.innerHTML, /devname[^>]*hsl\([^>]*>charger</);
	assert.match(devMenu.innerHTML, /devname[^>]*hsl\([^>]*>secc</);
	assert.match(devMenu.innerHTML, /busy: tio \(pid 6013\)/);

	const clickRow = (device) => devMenu.dispatch("click", {
		target: { closest: () => ({ dataset: { device } }) },
	});

	// toggling the unattached device attaches it under ITS config name — it
	// must not re-use another port's name (the old swap bug)
	clickRow("/dev/cu.usbserial-B");
	await tick();
	const attach = fetchLog.filter((c) => c.path === "/api/attach").at(-1);
	assert.ok(attach, "attach was called");
	assert.deepEqual(attach.body, {
		name: "secc", device: "/dev/cu.usbserial-B", baud: 115200, author: "user",
	});

	// toggling the attached device detaches that port by name
	clickRow("/dev/cu.usbserial-A");
	await tick();
	const detach = fetchLog.filter((c) => c.path === "/api/detach").at(-1);
	assert.ok(detach, "detach was called");
	assert.deepEqual(detach.body, { name: "charger", author: "user" });

	// a busy row is inert
	const before = fetchLog.length;
	clickRow("/dev/cu.usbserial-C");
	await tick();
	assert.equal(
		fetchLog.slice(before).filter((c) => c.path === "/api/attach" || c.path === "/api/detach").length,
		0, "busy device cannot be toggled");

	// the topbar button reflects every attached serial port
	es.emit("status", { head: 6, ports: [
		{ name: "charger", type: "serial", device: "/dev/cu.usbserial-A", baud: 115200, connected: true },
		{ name: "secc", type: "serial", device: "/dev/cu.usbserial-B", baud: 115200, connected: true },
	] });
	assert.equal(getEl("#devBtn").textContent, "charger · secc ▾");
});
