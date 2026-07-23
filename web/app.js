// logscope web client — zero dependencies, plain ES2022 modules.
// Talks only to the endpoints documented in doc/API.md.

/* ────────────────────────────── constants ────────────────────────────── */

const MAX_ITEMS      = 3000;   // hard DOM cap; oldest dropped first
const BACKLOG        = 500;    // lines fetched before the stream opens
const PAGE           = 2000;   // page size for gap-fill (API max is 5000)
const BOTTOM_SLACK   = 48;     // px from bottom that still counts as "at bottom"
const AUTOSAVE_MS    = 1500;
const NOTES_POLL_MS  = 10000;
const STATUS_POLL_MS = 5000;
const RATE_WINDOW_MS = 5000;

const KINDS = ['note', 'analysis', 'command', 'run', 'mark', 'error'];

const LS = {
  theme: 'logscope.theme',
  split: 'logscope.split',
  tab:   'logscope.tab',
  view:  'logscope.view',
};

/* ────────────────────────────── tiny utils ────────────────────────────── */

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function esc(s) {
	return String(s == null ? '' : s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** mono ms → mm:ss.mmm — kept for the hover title, as time since session start */
function fmtMono(ms) {
	if (typeof ms !== 'number' || !isFinite(ms)) return '--:--.---';
	const neg = ms < 0;
	let v = Math.abs(Math.round(ms));
	const mmm = v % 1000;
	v = (v - mmm) / 1000;
	const ss = v % 60;
	const mm = (v - ss) / 60;
	return (neg ? '-' : '') +
		String(mm).padStart(2, '0') + ':' +
		String(ss).padStart(2, '0') + '.' +
		String(mmm).padStart(3, '0');
}

/**
 * wallclock ms → local HH:MM:SS.mmm.
 * Absolute time, not uptime: the usual question is "what else was happening at
 * 14:32?" — correlating against a build, a server log, or a note elsewhere —
 * and time-since-boot cannot answer that.
 *
 * Hand-padded rather than toLocaleTimeString: locales disagree about zero
 * padding and some render midnight as 24:xx, and a time column that changes
 * width between rows is exactly what makes a log hard to scan.
 */
function fmtClock(t) {
	if (typeof t !== 'number' || !isFinite(t) || t <= 0) return '--:--:--.---';
	const d = new Date(t);
	return String(d.getHours()).padStart(2, '0') + ':' +
		String(d.getMinutes()).padStart(2, '0') + ':' +
		String(d.getSeconds()).padStart(2, '0') + '.' +
		String(d.getMilliseconds()).padStart(3, '0');
}

function fmtWall(t) {
	if (!t) return '';
	return new Date(t).toLocaleString([], { hour12: false });
}

/** stable pastel-ish hue per source name */
function srcColor(name) {
	let h = 0;
	const s = String(name || '');
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
	return `hsl(${h % 360} 62% 62%)`;
}

function debounce(fn, ms) {
	let id = 0;
	const w = (...a) => { clearTimeout(id); id = setTimeout(() => fn(...a), ms); };
	w.cancel = () => clearTimeout(id);
	w.now = (...a) => { clearTimeout(id); fn(...a); };
	return w;
}

async function api(path, opts) {
	const res = await fetch(path, {
		headers: { 'Accept': 'application/json', ...(opts && opts.body ? { 'Content-Type': 'application/json' } : {}) },
		...opts,
	});
	const txt = await res.text();
	if (!res.ok) {
		// The daemon always reports failures as {error:"..."} and that text is
		// the only actionable part — "held by tio (pid 6013)" beats "→ 409".
		let detail = '';
		try { detail = (JSON.parse(txt) || {}).error || ''; } catch (e) {}
		throw new Error(detail || `${opts && opts.method || 'GET'} ${path} → ${res.status}`);
	}
	return txt ? JSON.parse(txt) : {};
}

const jpost = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
const jput  = (path, body) => api(path, { method: 'PUT',  body: JSON.stringify(body) });

/* ────────────────────────────── state ────────────────────────────── */

const state = {
	// stream cursor / dedupe
	lastSeq: 0,             // highest line seq ingested (stream cursor)
	head: 0,                // server head
	seqSeen: new Set(),     // seqs currently held in `items`
	dropCutoff: 0,          // every seq <= this was rendered and then trimmed away
	clearCutoff: 0,         // user hit clear: annotations anchored <= this are gone too
	annIds: new Set(),      // annotation ids ever ingested (incl. reconciled temps)

	items: [],              // merged, ordered [{type,seq,t,id,data,el,vis}]
	anns: [],               // annotations only, for the side tab
	pendingAnns: [],        // optimistic user notes awaiting server echo

	sources: new Set(),
	srcOff: new Set(),
	lvlOff: new Set(),
	filterRe: null,
	filterRaw: '',

	totalLines: 0,          // line items currently held
	visLines: 0,            // ...of which pass the filter

	autoScroll: true,
	annStick: true,         // side-list mirror of autoScroll; the flag survives
	                        // display:none, where scrollTop does not
	newCount: 0,

	rate: [],               // recent line arrival timestamps
	sessionId: null,
	ports: [],
	devices: [],            // last /api/devices payload, for the picker menu
	devSig: null,           // last-rendered device list signature

	esConnected: false,
	backoff: 1000,
};

const el = {
	list:      $('#logList'),
	scroll:    $('#logScroll'),
	empty:     $('#logEmpty'),
	pill:      $('#newPill'),
	filter:    $('#filterText'),
	filterErr: $('#filterErr'),
	count:     $('#countLabel'),
	jump:      $('#jumpSeq'),
	srcTogs:   $('#srcToggles'),
	conn:      $('#connState'),
	statHead:  $('#statHead'),
	statRate:  $('#statRate'),
	statPorts: $('#statPorts'),
	statSess:  $('#statSession'),
	cmdPort:   $('#cmdPort'),
	devBtn:    $('#devBtn'),
	devMenu:   $('#devMenu'),
	baudSelect: $('#baudSelect'),
	cmdText:   $('#cmdText'),
	cmdBar:    $('#cmdbar'),
	annList:   $('#annList'),
	annFilter: $('#annFilter'),
	annCount:  $('#annCount'),
	editor:    $('#notesEditor'),
	preview:   $('#notesPreview'),
	saveState: $('#saveState'),
	notesPath: $('#notesPath'),
	conflict:  $('#conflict'),
	saveError: $('#saveError'),
	saveErrMsg:$('#saveErrorMsg'),
};

/* ══════════════════════════════ ordering ══════════════════════════════ */

// Lines sort before annotations anchored at the same seq ("appears after this
// line"); annotations at the same seq sort by t then id, so ordering is stable
// no matter which transport delivered them first.
function cmpItems(a, b) {
	if (a.seq !== b.seq) return a.seq - b.seq;
	const at = a.type === 'line' ? 0 : 1;
	const bt = b.type === 'line' ? 0 : 1;
	if (at !== bt) return at - bt;
	if (at === 0) return 0;
	const ta = a.t || 0, tb = b.t || 0;
	if (ta !== tb) return ta - tb;
	return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
}

/** first index i where items[i] sorts after `it` (i.e. the insertion point) */
function insertIndex(it) {
	const arr = state.items;
	let lo = 0, hi = arr.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (cmpItems(arr[mid], it) <= 0) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/* ══════════════════════════════ filtering ══════════════════════════════ */

function buildFilter(raw) {
	state.filterRaw = raw;
	state.filterRe = null;
	el.filterErr.hidden = true;
	const s = raw.trim();
	if (!s) return;
	const m = s.match(/^\/(.*)\/([a-z]*)$/);
	try {
		if (m && m[1]) {
			state.filterRe = new RegExp(m[1], m[2].includes('i') ? m[2] : m[2] + 'i');
		} else {
			state.filterRe = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
		}
	} catch (e) {
		el.filterErr.hidden = false;
		state.filterRe = null;
	}
}

function lineVisible(l) {
	if (l.lvl && state.lvlOff.has(l.lvl)) return false;
	if (l.src && state.srcOff.has(l.src)) return false;
	if (state.filterRe && !state.filterRe.test(l.raw || '')) return false;
	return true;
}

function annVisible(a) {
	// level/source toggles never hide analysis; only the text filter narrows it.
	if (state.filterRe) {
		const hay = `${a.kind} ${a.author} ${a.text || ''} ${a.meta ? JSON.stringify(a.meta) : ''}`;
		if (!state.filterRe.test(hay)) return false;
	}
	return true;
}

function itemVisible(it) {
	return it.type === 'line' ? lineVisible(it.data) : annVisible(it.data);
}

function applyVisibility(it) {
	const v = itemVisible(it);
	if (it.vis === v) return;
	it.vis = v;
	it.el.hidden = !v;
	if (it.type === 'line') state.visLines += v ? 1 : -1;
}

function refilter() {
	state.visLines = 0;
	for (const it of state.items) {
		const v = itemVisible(it);
		it.vis = v;
		it.el.hidden = !v;
		if (it.type === 'line' && v) state.visLines++;
	}
	updateCount();
}

function updateCount() {
	el.count.textContent = `showing ${state.visLines} of ${state.totalLines}`;
	el.empty.hidden = state.items.length > 0;
}

/* ══════════════════════════════ rendering ══════════════════════════════ */

function renderLine(l) {
	const d = document.createElement('div');
	d.className = 'ln' + (l.lvl ? ' is-' + l.lvl : '');
	d.dataset.seq = l.seq;

	const parsed = l.lvl != null || l.tag != null;
	const time = fmtClock(l.t);
	const title = [
		l.t ? fmtWall(l.t) : '',
		`+${fmtMono(l.mono)} since session start`,
		l.dev_ts ? `dev ${l.dev_ts}` : '',
	].filter(Boolean).join('  ');

	let html =
		`<span class="gut" data-act="note" title="annotate this line">+</span>` +
		`<span class="mono" title="${esc(title)}">${esc(time)}</span>` +
		`<span class="seq" data-act="perma" title="copy permalink">${l.seq}</span>` +
		`<span class="src" style="color:${srcColor(l.src)}">${esc(l.src)}</span>`;

	if (parsed) {
		html +=
			`<span class="lvl lvl-${esc(l.lvl || 'inf')}">${esc(l.lvl || '')}</span>` +
			`<span class="tag">${esc(l.tag || '')}</span>` +
			`<span class="msg">${esc(l.msg != null ? l.msg : l.raw)}</span>`;
	} else {
		html += `<span class="raw">${esc(l.raw)}</span>`;
	}
	d.innerHTML = html;
	return d;
}

function annLabel(a) {
	const cls = authorClass(a.author);
	const who = a.author || 'claude';
	return `<span class="alabel">${esc(a.kind)} · ` +
		`<span class="who who-${cls}">${esc(who)}</span> · ` +
		`<span class="who">${esc(fmtClock(a.t))}</span></span>`;
}

/**
 * Who made this annotation, as a css-safe class.
 * `command` annotations especially need this: "did I send that, or did Claude?"
 * is the first question asked when reading back a session, and the answer
 * changes how you interpret everything after it.
 */
function authorClass(author) {
	const a = String(author || '').toLowerCase();
	if (a === 'user') return 'user';
	if (a === 'system') return 'system';
	return 'claude';
}

function renderAnn(a) {
	const kind = KINDS.includes(a.kind) ? a.kind : 'note';
	const d = document.createElement('div');
	d.className = `an k-${kind} by-${authorClass(a.author)}` + (a._pending ? ' pending' : '');
	d.dataset.id = a.id;
	d.dataset.seq = a.seq;
	d.dataset.author = a.author || '';

	const meta = a.meta || {};

	if (kind === 'mark') {
		const label = meta.label || a.text || 'mark';
		d.innerHTML = `<span class="mlabel">${esc(label)}</span>`;
		return d;
	}

	if (kind === 'run') {
		const exit = meta.exit;
		const okCls = exit === 0 ? 'exit-ok' : 'exit-bad';
		const label = a.text || meta.label || meta.cmd || 'run';
		const tail = meta.stdout_tail || '';
		d.innerHTML =
			`<details><summary>` +
			`<span class="rlabel">${esc(label)}</span> ` +
			`<span class="${okCls}">exit ${esc(exit == null ? '?' : exit)}</span> ` +
			`<span class="dur">${esc(meta.ms == null ? '' : meta.ms + 'ms')}</span>` +
			`</summary>` +
			annLabel(a) +
			(meta.cmd ? `<pre>$ ${esc(meta.cmd)}${meta.cwd ? '\n# cwd: ' + esc(meta.cwd) : ''}</pre>` : '') +
			(tail ? `<pre>${esc(tail)}</pre>` : `<pre class="muted">(no stdout captured)</pre>`) +
			`</details>`;
		return d;
	}

	let body = esc(a.text || '');
	if (kind === 'command' && meta.data != null) {
		body = esc(`→ ${meta.port ? meta.port + ': ' : ''}${meta.data}`) + (a.text ? '\n' + esc(a.text) : '');
	}
	d.innerHTML = annLabel(a) + `<div class="atext">${body}</div>`;
	return d;
}

/* ══════════════════════════ insert / trim / scroll ══════════════════════════ */

function isAtBottom(s = el.scroll) {
	return s.scrollHeight - s.scrollTop - s.clientHeight <= BOTTOM_SLACK;
}

function scrollToBottom() {
	el.scroll.scrollTop = el.scroll.scrollHeight;
}

function insertItem(it) {
	const idx = insertIndex(it);
	it.vis = itemVisible(it);
	it.el.hidden = !it.vis;
	if (idx >= state.items.length) el.list.appendChild(it.el);
	else el.list.insertBefore(it.el, state.items[idx].el);
	state.items.splice(idx, 0, it);
	if (it.type === 'line') {
		state.totalLines++;
		if (it.vis) state.visLines++;
	}
	return idx;
}

function trim(atBottom) {
	const over = state.items.length - MAX_ITEMS;
	if (over <= 0) return;
	let removedH = 0;
	for (let i = 0; i < over; i++) {
		const it = state.items[i];
		if (!atBottom && !it.el.hidden) removedH += it.el.offsetHeight;
		if (it.type === 'line') {
			state.totalLines--;
			if (it.vis) state.visLines--;
			state.seqSeen.delete(it.seq);
			// Everything at or below this seq is gone for good; never re-render it.
			if (it.seq > state.dropCutoff) state.dropCutoff = it.seq;
		}
		it.el.remove();
	}
	state.items.splice(0, over);
	if (!atBottom && removedH > 0) {
		el.scroll.scrollTop = Math.max(0, el.scroll.scrollTop - removedH);
	}
	// a composer whose anchor line was trimmed away has to go too
	if (composer.node && !composer.node.isConnected) closeComposer();
	if (composer.node && composer.anchorEl && !composer.anchorEl.isConnected) closeComposer();
}

/* Incoming items are buffered and flushed once per frame so a burst of
 * thousands of lines costs one layout, not thousands. */
let flushQueued = false;
const inbox = [];

function enqueue(it) {
	inbox.push(it);
	if (!flushQueued) {
		flushQueued = true;
		requestAnimationFrame(flush);
	}
}

function flush() {
	flushQueued = false;
	if (!inbox.length) return;
	const atBottom = state.autoScroll && isAtBottom();
	let newLines = 0;

	for (const it of inbox) {
		insertItem(it);
		if (it.type === 'line') newLines++;
		else if (it.type === 'ann') queueAnnListRender();
	}
	inbox.length = 0;

	trim(atBottom);
	updateCount();

	if (atBottom) {
		scrollToBottom();
		state.newCount = 0;
		el.pill.hidden = true;
	} else if (newLines) {
		state.newCount += newLines;
		el.pill.hidden = false;
		el.pill.textContent = `${state.newCount} new line${state.newCount === 1 ? '' : 's'} ↓`;
	}
}

/* ══════════════════════════════ ingest ══════════════════════════════ */

function noteSource(src) {
	if (!src || state.sources.has(src)) return;
	state.sources.add(src);
	const b = document.createElement('button');
	b.className = 'tg tg-src on';
	b.dataset.src = src;
	b.textContent = src;
	b.style.borderColor = srcColor(src);
	el.srcTogs.appendChild(b);
}

function ingestLine(l) {
	if (!l || typeof l.seq !== 'number') return false;
	if (l.seq <= state.dropCutoff) return false;   // already shown and trimmed
	if (state.seqSeen.has(l.seq)) return false;    // already on screen
	state.seqSeen.add(l.seq);
	noteSource(l.src);
	if (l.seq > state.lastSeq) state.lastSeq = l.seq;
	if (l.seq > state.head) state.head = l.seq;
	enqueue({ type: 'line', seq: l.seq, t: l.t, id: null, data: l, el: renderLine(l), vis: true });
	return true;
}

function findPendingMatch(a) {
	if (a.author !== 'user') return -1;
	return state.pendingAnns.findIndex(p =>
		p.seq === a.seq && p.kind === a.kind && p.text === a.text);
}

function ingestAnnotation(a) {
	if (!a || a.id == null) return false;
	if (state.annIds.has(a.id)) return false;

	// Anchored inside a range the user cleared: it went with its lines, and a
	// refetch (gap fill re-reads ALL annotations) must not resurrect it.
	if (typeof a.seq === 'number' && a.seq <= state.clearCutoff) {
		state.annIds.add(a.id);
		return false;
	}

	// reconcile an optimistic render with the server's authoritative copy
	const pi = findPendingMatch(a);
	if (pi >= 0) {
		const p = state.pendingAnns[pi];
		state.pendingAnns.splice(pi, 1);
		state.annIds.add(a.id);
		const it = state.items.find(x => x.type === 'ann' && x.id === p.tempId);
		if (it) {
			it.id = a.id;
			it.data = a;
			const fresh = renderAnn(a);
			it.el.replaceWith(fresh);
			it.el = fresh;
			it.vis = itemVisible(it);
			it.el.hidden = !it.vis;
		}
		const ai = state.anns.findIndex(x => x.id === p.tempId);
		if (ai >= 0) state.anns[ai] = a; else state.anns.push(a);
		state.annIds.delete(p.tempId);
		queueAnnListRender();
		return true;
	}

	state.annIds.add(a.id);
	state.anns.push(a);
	state.anns.sort((x, y) => (x.seq - y.seq) || ((x.t || 0) - (y.t || 0)));

	// An annotation anchored below the trim cutoff has no line left to sit
	// beside; it stays in the side list but is not injected into the stream.
	if (typeof a.seq === 'number' && a.seq <= state.dropCutoff) {
		queueAnnListRender();
		return true;
	}
	enqueue({ type: 'ann', seq: a.seq == null ? state.head : a.seq, t: a.t, id: a.id, data: a, el: renderAnn(a), vis: true });
	return true;
}

function ingestLines(arr) {
	let n = 0;
	for (const l of arr || []) if (ingestLine(l)) n++;
	return n;
}

/* ══════════════════════════ backlog + gap fill ══════════════════════════ */

async function fetchLinesFrom(from) {
	let cursor = from;
	for (let guard = 0; guard < 50; guard++) {
		const r = await api(`/api/lines?from=${cursor}&limit=${PAGE}&order=asc`);
		const lines = r.lines || [];
		if (typeof r.head === 'number' && r.head > state.head) state.head = r.head;
		ingestLines(lines);
		if (!lines.length) break;
		cursor = lines[lines.length - 1].seq;
		if (lines.length < PAGE) break;
	}
	return cursor;
}

/* Annotations are low-volume (tens–hundreds per session), so the whole set is
 * fetched every time: the side tab shows the full chronology, while the stream
 * only inlines the ones inside the retained line window. */
async function fetchAllAnnotations() {
	const r = await api('/api/annotations?from=0');
	for (const a of r.annotations || []) ingestAnnotation(a);
}

async function loadBacklog() {
	let head = 0;
	try {
		const st = await api('/api/status');
		applyStatus(st);
		head = st.head || 0;
	} catch (e) { /* daemon may still be starting; fall through */ }

	const from = Math.max(0, head - BACKLOG);
	// nothing at or below `from` is ever rendered in this view
	state.dropCutoff = from;
	try {
		await fetchLinesFrom(from);
	} catch (e) {
		console.warn('backlog fetch failed', e);
	}
	try {
		await fetchAllAnnotations();
	} catch (e) {
		console.warn('annotation backlog failed', e);
	}
	flush();
	scrollToBottom();
}

/**
 * Re-sync anything the stream missed while it was down. Runs BEFORE the new
 * EventSource is opened, so the `from` cursor we hand the stream is already
 * current; the overlap between the two is absorbed by the seq/id dedupe.
 */
async function gapFill() {
	try {
		await fetchLinesFrom(state.lastSeq);
		await fetchAllAnnotations();
	} catch (e) {
		console.warn('gap fill failed', e);
	}
}

/* ══════════════════════════════ stream ══════════════════════════════ */

let es = null;
let reconnectTimer = 0;

function setConn(kind, text) {
	el.conn.className = 'conn conn-' + kind;
	el.conn.textContent = text;
}

function connect() {
	if (es) { try { es.close(); } catch (e) {} es = null; }
	setConn('retry', 'connecting…');

	const src = new EventSource(`/api/stream?from=${state.lastSeq}`);
	es = src;

	src.onopen = () => {
		if (es !== src) return;
		state.esConnected = true;
		state.backoff = 1000;
		setConn('live', 'live');
	};

	src.addEventListener('line', (e) => {
		try { ingestLine(JSON.parse(e.data)); markRate(); } catch (err) { console.warn('bad line event', err); }
	});

	src.addEventListener('annotation', (e) => {
		try { ingestAnnotation(JSON.parse(e.data)); } catch (err) { console.warn('bad annotation event', err); }
	});

	src.addEventListener('status', (e) => {
		try { applyStatus(JSON.parse(e.data)); } catch (err) {}
	});

	src.addEventListener('ping', () => { /* keepalive */ });

	src.onerror = () => {
		if (es !== src) return;
		// Take over retries ourselves: EventSource would replay the *original*
		// `from` cursor on its own reconnect, re-sending the whole session.
		try { src.close(); } catch (e) {}
		es = null;
		state.esConnected = false;
		setConn('down', `reconnecting in ${Math.round(state.backoff / 1000)}s…`);
		scheduleReconnect();
	};
}

function scheduleReconnect() {
	clearTimeout(reconnectTimer);
	const wait = state.backoff;
	state.backoff = Math.min(state.backoff * 2, 8000);
	reconnectTimer = setTimeout(async () => {
		setConn('retry', 'resyncing…');
		await gapFill();     // fill the hole before going live again
		connect();
	}, wait);
}

/* ══════════════════════════════ status ══════════════════════════════ */

function applyStatus(st) {
	if (!st) return;
	if (st.sessionId && st.sessionId !== state.sessionId) {
		state.sessionId = st.sessionId;
		el.statSess.textContent = st.sessionId;
		el.statSess.title = st.project ? `project: ${st.project}` : 'session id';
	}
	if (typeof st.head === 'number' && st.head > state.head) state.head = st.head;
	el.statHead.textContent = state.head;

	if (Array.isArray(st.ports)) {
		state.ports = st.ports;
		el.statPorts.innerHTML = st.ports.map(p =>
			`<span class="port" title="${esc(p.device || '')} @ ${esc(p.baud || '')} — ${p.lines || 0} lines">` +
			`<span class="dot${p.connected ? ' up' : ''}"></span>${esc(p.name)}</span>`
		).join('') || '<span class="port">no ports</span>';

		const cur = el.cmdPort.value;
		// Only serial sources can accept input; a `file` tail is read-only, so
		// offering it here would just produce a 409 on send.
		const names = st.ports.filter(p => p.writable !== false).map(p => p.name);
		if (names.join(' ') !== Array.from(el.cmdPort.options).map(o => o.value).join(' ')) {
			el.cmdPort.innerHTML = names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
			if (names.includes(cur)) el.cmdPort.value = cur;
		}
		for (const p of st.ports) noteSource(p.name);

		const serial = st.ports.filter(p => p.type === 'serial');
		el.devBtn.textContent = (serial.length
			? serial.map(p => p.name).join(' · ')
			: 'no device') + ' ▾';
		// mirror the attached baud only while it is unambiguous
		if (serial.length === 1 && serial[0].baud && document.activeElement !== el.baudSelect) {
			el.baudSelect.value = String(serial[0].baud);
		}
	}
}

async function pollStatus() {
	try { applyStatus(await api('/api/status')); } catch (e) {}
}

/* ── device picker ─────────────────────────────────────────────────────── */

/**
 * The picker is a checklist, not a <select>: several devices can be attached
 * at once, each as its own named port, and toggling a row attaches/detaches
 * that device only. It never re-targets another port's name — the old
 * single-select always attached under the *first* port's name, which is what
 * used to swap a second adapter onto the wrong port.
 *
 * Ports held by another process are shown too, disabled and labelled with the
 * culprit, because "my adapter isn't in the list" is a far worse experience
 * than "my adapter is listed as busy with tio".
 */
async function refreshDevices() {
	let devices;
	try { ({ devices } = await api('/api/devices')); } catch (e) { return; }
	state.devices = devices;
	const sig = devices.map(d => `${d.device}|${d.attachedAs}|${d.configuredAs}|${d.heldBy}`).join(',');
	if (sig === state.devSig) return;          // nothing changed; don't stomp the menu
	state.devSig = sig;
	renderDevMenu();
}

function renderDevMenu() {
	el.devMenu.innerHTML = (state.devices || []).map(d => {
		const busy = d.heldBy && !d.attachedAs;
		const on = !!d.attachedAs;
		// live name wins; otherwise the name config.json would give this device
		const name = d.attachedAs || d.configuredAs;
		// same hue the log pane gives this source, so badge and log column match
		const nameStyle = name
			? ` style="color:${srcColor(name)};border-color:color-mix(in srgb, ${srcColor(name)} 45%, transparent)"`
			: '';
		return `<div class="devrow${busy ? ' busy' : ''}${on ? ' on' : ''}" data-device="${esc(d.device)}"` +
			` title="${esc(d.device)}">` +
			`<span class="devck">${on ? '✓' : ''}</span>` +
			`<span class="devlabel">${esc(d.label)}</span>` +
			(name ? `<span class="devname"${nameStyle}>${esc(name)}</span>` : '') +
			(busy ? `<span class="devnote">busy: ${esc(d.heldBy)}</span>` :
				(!d.likely && !on) ? `<span class="devnote">bt</span>` : '') +
			`</div>`;
	}).join('') || `<div class="devrow busy">no serial devices</div>`;
}

let devToggling = false;

async function toggleDevice(device) {
	const d = (state.devices || []).find(x => x.device === device);
	if (!d || devToggling || (d.heldBy && !d.attachedAs)) return;
	devToggling = true;
	try {
		if (d.attachedAs) {
			const r = await jpost('/api/detach', { name: d.attachedAs, author: 'user' });
			if (r.ports) applyStatus({ ports: r.ports });
		} else {
			setConn('retry', `opening ${d.label}…`);
			const r = await jpost('/api/attach', {
				name: d.configuredAs || d.label.replace(/[^\w.-]+/g, '-'),
				device: d.device,
				baud: Number(el.baudSelect.value) || 115200,
				author: 'user',
			});
			if (r.ports) applyStatus({ ports: r.ports });
			setConn(state.esConnected ? 'live' : 'down', state.esConnected ? 'live' : 'offline');
		}
	} catch (e) {
		// The daemon keeps retrying attaches in the background, so this is
		// informational rather than fatal — but say it out loud.
		setConn('down', String(e.message || e));
		setTimeout(() => setConn(state.esConnected ? 'live' : 'down',
			state.esConnected ? 'live' : 'offline'), 3000);
	} finally {
		devToggling = false;
		state.devSig = null;
		refreshDevices();
	}
}

el.devMenu.addEventListener('click', (e) => {
	const row = e.target.closest('.devrow');
	if (row && row.dataset.device) toggleDevice(row.dataset.device);
});

el.devBtn.addEventListener('click', (e) => {
	e.stopPropagation();
	el.devMenu.hidden = !el.devMenu.hidden;
	if (!el.devMenu.hidden) {
		// mobile renders the menu position:fixed and viewport-wide; hand it the
		// button's bottom edge so it still opens where the tap happened
		const r = el.devBtn.getBoundingClientRect();
		if (r && isFinite(r.bottom)) {
			document.documentElement.style.setProperty('--devmenu-top', (r.bottom + 6) + 'px');
		}
		state.devSig = null;
		refreshDevices();
	}
});

// click anywhere else closes the menu
document.addEventListener('click', (e) => {
	if (!el.devMenu.hidden && !(e.target.closest && e.target.closest('#devPick'))) {
		el.devMenu.hidden = true;
	}
});

// Baud applies to the next attach. With exactly one port attached, changing it
// re-opens that port at the new rate — the common "wrong baud, fix it" move.
// With several attached it stays hands-off: guessing which port to bounce
// would be the swap bug all over again.
el.baudSelect.addEventListener('change', async () => {
	const serial = state.ports.filter(p => p.type === 'serial' && p.device);
	if (serial.length !== 1) return;
	const p = serial[0];
	try {
		const r = await jpost('/api/attach', {
			name: p.name, device: p.device,
			baud: Number(el.baudSelect.value) || 115200, author: 'user',
		});
		if (r.ports) applyStatus({ ports: r.ports });
	} catch (e) {
		setConn('down', String(e.message || e));
	}
	state.devSig = null;
	refreshDevices();
});

/* line-rate meter */
function markRate() { state.rate.push(Date.now()); }

setInterval(() => {
	const cut = Date.now() - RATE_WINDOW_MS;
	while (state.rate.length && state.rate[0] < cut) state.rate.shift();
	el.statRate.textContent = (state.rate.length / (RATE_WINDOW_MS / 1000)).toFixed(1);
	el.statHead.textContent = state.head;
}, 500);

/* ══════════════════════════════ composer ══════════════════════════════ */

const composer = { node: null, anchorEl: null, seq: 0 };

function closeComposer() {
	if (composer.node) composer.node.remove();
	composer.node = null;
	composer.anchorEl = null;
	composer.seq = 0;
}

function openComposer(seq, anchorEl) {
	closeComposer();
	const box = document.createElement('div');
	box.className = 'composer';
	box.innerHTML =
		`<textarea placeholder="note anchored at seq ${seq}…"></textarea>` +
		`<div><button class="btn tiny" data-act="save">add</button>` +
		`<div class="hint">⌘/Ctrl+Enter · Esc</div></div>`;
	anchorEl.after(box);
	composer.node = box;
	composer.anchorEl = anchorEl;
	composer.seq = seq;

	const ta = box.querySelector('textarea');
	ta.focus();

	const submit = () => {
		const text = ta.value.trim();
		if (!text) { closeComposer(); return; }
		closeComposer();
		addUserNote(seq, text);
	};
	box.querySelector('[data-act="save"]').addEventListener('click', submit);
	ta.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
		else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeComposer(); }
	});
}

let tmpN = 0;

async function addUserNote(seq, text) {
	const tempId = `tmp-${++tmpN}`;
	const optimistic = {
		id: tempId, seq, t: Date.now(), kind: 'note',
		author: 'user', text, meta: {}, _pending: true,
	};
	state.annIds.add(tempId);
	state.anns.push(optimistic);
	state.pendingAnns.push({ tempId, seq, kind: 'note', text });
	enqueue({ type: 'ann', seq, t: optimistic.t, id: tempId, data: optimistic, el: renderAnn(optimistic), vis: true });
	queueAnnListRender();

	try {
		const created = await jpost('/api/annotate', { seq, kind: 'note', author: 'user', text, meta: {} });
		// Either this or the SSE echo wins; whichever is second is a no-op.
		ingestAnnotation(created);
	} catch (e) {
		const it = state.items.find(x => x.type === 'ann' && x.id === tempId);
		if (it) {
			it.el.classList.remove('pending');
			it.el.style.borderLeftColor = 'var(--bad)';
			it.el.title = 'not saved: ' + e.message;
		}
		const pi = state.pendingAnns.findIndex(p => p.tempId === tempId);
		if (pi >= 0) state.pendingAnns.splice(pi, 1);
	}
}

/* ══════════════════════════ permalink / jump ══════════════════════════ */

function findLineEl(seq) {
	const it = state.items.find(x => x.type === 'line' && x.seq === seq);
	return it ? it.el : null;
}

let flashTimer = null;
let flashNode = null;
function flash(node) {
	// Clear any in-flight flash first, and force a reflow before re-adding, so
	// clicking the same target twice actually replays the animation instead of
	// doing nothing.
	if (flashNode) flashNode.classList.remove('hl');
	clearTimeout(flashTimer);
	void node.offsetWidth;
	node.classList.add('hl');
	flashNode = node;
	flashTimer = setTimeout(() => {
		node.classList.remove('hl');
		if (flashNode === node) flashNode = null;
	}, 1500);
}

function scrollToSeq(seq, { setHash = false } = {}) {
	const node = findLineEl(seq);
	if (!node) {
		// outside the retained window — say so without stomping the status bar
		el.jump.classList.add('miss');
		el.jump.title = `seq ${seq} is not in the loaded window`;
		setTimeout(() => { el.jump.classList.remove('miss'); el.jump.title = 'jump to seq'; }, 1600);
		return false;
	}
	state.autoScroll = false;
	node.scrollIntoView({ block: 'center' });
	flash(node);
	if (setHash) history.replaceState(null, '', `#seq=${seq}`);
	return true;
}

/**
 * Scroll to an annotation itself, not to the line it is anchored to.
 *
 * An annotation anchors to the seq of the last line that existed when it was
 * made, so for a `command` that is the line *before* the command was sent.
 * Jumping to that seq highlights the wrong row — the user asked for the
 * annotation, so show them the annotation.
 */
function scrollToAnn(id, seqFallback) {
	const it = state.items.find(x => x.type === 'ann' && x.id === id);
	if (it && it.el && it.el.isConnected) {
		// the text filter can hide the annotation inside the stream; scrolling to
		// a hidden node silently does nothing, so drop the filter and land on it
		if (it.el.hidden && state.filterRaw) {
			el.filter.value = '';
			buildFilter('');
			refilter();
		}
		state.autoScroll = false;
		it.el.scrollIntoView({ block: 'center' });
		flash(it.el);
		return true;
	}
	return seqFallback != null && isFinite(seqFallback)
		? scrollToSeq(seqFallback, { setHash: true })
		: false;
}

function hashSeq() {
	const m = /(?:^|[#&])seq=(\d+)/.exec(location.hash || '');
	return m ? Number(m[1]) : null;
}

/* ══════════════════════════ annotations tab ══════════════════════════ */

let annRenderQueued = false;
function queueAnnListRender() {
	if (annRenderQueued) return;
	annRenderQueued = true;
	requestAnimationFrame(() => { annRenderQueued = false; renderAnnList(); });
}

function renderAnnList() {
	const q = el.annFilter.value.trim().toLowerCase();
	const rows = [];
	let shown = 0;
	for (const a of state.anns) {
		const hay = `${a.kind} ${a.author} ${a.text || ''} ${a.meta ? JSON.stringify(a.meta) : ''}`.toLowerCase();
		if (q && !hay.includes(q)) continue;
		shown++;
		const kind = KINDS.includes(a.kind) ? a.kind : 'note';
		const body = kind === 'mark'
			? (a.meta && a.meta.label ? a.meta.label : (a.text || 'mark'))
			: (a.text || (a.meta && a.meta.cmd) || (a.meta && a.meta.data) || '');
		rows.push(
			`<div class="anitem k-${kind} by-${authorClass(a.author)}" data-id="${esc(a.id || '')}"` +
			` data-seq="${a.seq == null ? '' : a.seq}">` +
			`<div class="ahead">${esc(kind)}<span class="who who-${authorClass(a.author)}">${esc(a.author || '')}</span>` +
			`<span class="who">${esc(fmtClock(a.t))}</span>` +
			`<span class="sq">#${a.seq == null ? '?' : a.seq}</span></div>` +
			`<div class="abody">${esc(body)}</div></div>`
		);
	}
	el.annList.innerHTML = rows.join('') || `<div class="empty">no annotations</div>`;
	el.annCount.textContent = `${shown} / ${state.anns.length}`;
	if (state.annStick) el.annList.scrollTop = el.annList.scrollHeight;
}

el.annList.addEventListener('scroll', () => {
	state.annStick = isAtBottom(el.annList);
});

el.annFilter.addEventListener('input', renderAnnList);
el.annList.addEventListener('click', (e) => {
	const row = e.target.closest('.anitem');
	if (!row) return;
	const seq = row.dataset.seq ? Number(row.dataset.seq) : null;
	// On mobile the log pane is display:none right now, and scrollIntoView on a
	// hidden subtree does nothing. Reveal it first, and drop auto-scroll before
	// the switch so setView doesn't re-pin the tail out from under the jump.
	if (mobileView()) {
		state.autoScroll = false;
		setView('log');
		// two frames: one for the pane to lay out, one for the scroll
		requestAnimationFrame(() => requestAnimationFrame(() => {
			scrollToAnn(row.dataset.id, seq);
		}));
		return;
	}
	scrollToAnn(row.dataset.id, seq);
});

/* ══════════════════════════ markdown renderer ══════════════════════════ */

function safeUrl(u) {
	const s = String(u).trim();
	if (/^(https?:\/\/|mailto:|#|\/|\.\/|\.\.\/)/i.test(s)) return s;
	return null;
}

function mdInline(s) {
	const parts = s.split(/(`[^`\n]+`)/g);
	return parts.map((p) => {
		if (p.length > 1 && p.startsWith('`') && p.endsWith('`')) {
			return `<code>${p.slice(1, -1)}</code>`;
		}
		p = p.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, t, u) => {
			const href = safeUrl(u);
			return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${t}</a>` : m;
		});
		p = p.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
		p = p.replace(/__([^_]+)__/g, '<strong>$1</strong>');
		p = p.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
		p = p.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
		return p;
	}).join('');
}

// control chars as fence placeholders; they cannot appear in escaped text
const F_OPEN = String.fromCharCode(1);
const F_CLOSE = String.fromCharCode(2);
const F_RE = new RegExp('^' + F_OPEN + '(\\d+)' + F_CLOSE + '$');

function mdRender(srcText) {
	// escape first: everything downstream operates on already-safe text
	let text = esc(String(srcText || '').replace(/\r\n?/g, '\n'))
		.split(F_OPEN).join('').split(F_CLOSE).join('');

	// pull fenced code blocks out so no inline rule touches them
	const fences = [];
	const cls = (lang) => String(lang).trim().replace(/[^\w.+-]/g, '');
	const stash = (html) => {
		fences.push(html);
		return F_OPEN + (fences.length - 1) + F_CLOSE;
	};
	text = text.replace(/^```([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm, (m, lang, body) =>
		stash(`<pre><code class="lang-${cls(lang)}">${body.replace(/\n$/, '')}</code></pre>`));
	// unterminated fence running to EOF
	text = text.replace(/^```([^\n]*)\n([\s\S]*)$/m, (m, lang, body) =>
		stash(`<pre><code class="lang-${cls(lang)}">${body}</code></pre>`));

	const lines = text.split('\n');
	const out = [];
	let para = [];
	let list = null;      // 'ul' | 'ol'
	let quote = [];

	const flushPara = () => {
		if (para.length) { out.push(`<p>${mdInline(para.join('\n'))}</p>`); para = []; }
	};
	const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
	const flushQuote = () => {
		if (quote.length) { out.push(`<blockquote>${mdRenderInner(quote.join('\n'))}</blockquote>`); quote = []; }
	};
	const flushAll = () => { flushPara(); flushList(); flushQuote(); };

	for (const raw of lines) {
		const line = raw.replace(/\s+$/, '');

		const fence = F_RE.exec(line.trim());
		if (fence) { flushAll(); out.push(fences[Number(fence[1])]); continue; }

		if (!line.trim()) { flushAll(); continue; }

		if (/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }

		const h = /^ {0,3}(#{1,6})\s+(.*)$/.exec(line);
		if (h) { flushAll(); const n = h[1].length; out.push(`<h${n}>${mdInline(h[2])}</h${n}>`); continue; }

		// '>' has already been escaped to &gt; by esc()
		const q = /^ {0,3}(?:>|&gt;)\s?(.*)$/.exec(line);
		if (q) { flushPara(); flushList(); quote.push(q[1]); continue; }
		flushQuote();

		const ul = /^ {0,3}[-*+]\s+(.*)$/.exec(line);
		if (ul) {
			flushPara();
			if (list !== 'ul') { flushList(); out.push('<ul>'); list = 'ul'; }
			out.push(`<li>${mdInline(ul[1])}</li>`);
			continue;
		}
		const ol = /^ {0,3}(\d+)[.)]\s+(.*)$/.exec(line);
		if (ol) {
			flushPara();
			if (list !== 'ol') { flushList(); out.push('<ol>'); list = 'ol'; }
			out.push(`<li>${mdInline(ol[2])}</li>`);
			continue;
		}
		flushList();
		para.push(line);
	}
	flushAll();
	return out.join('\n');
}

// blockquote bodies are already escaped; render them without re-escaping
function mdRenderInner(escaped) {
	const parts = escaped.split('\n').filter(l => l.trim());
	return parts.map(l => `<p>${mdInline(l)}</p>`).join('');
}

/* ══════════════════════════ knowledge tab ══════════════════════════ */

const notes = {
	remoteMtime: null,
	remoteText: '',
	theirs: null,
	dirty: false,
	saving: false,
	lastError: null,
};

function setSaveState(s, msg) {
	el.saveState.dataset.state = s;
	el.saveState.textContent =
		s === 'saving' ? 'saving…' :
		s === 'dirty'  ? 'unsaved' :
		s === 'error'  ? 'save failed' : 'saved';
	el.saveError.hidden = s !== 'error';
	if (s === 'error') el.saveErrMsg.textContent = msg || 'save failed';
}

async function loadNotes(initial) {
	const r = await api('/api/notes');
	notes.remoteMtime = r.mtime ?? null;
	notes.remoteText = r.markdown || '';
	if (r.path) { el.notesPath.textContent = r.path; el.notesPath.title = r.path; }
	if (initial || (!notes.dirty && document.activeElement !== el.editor)) {
		if (el.editor.value !== notes.remoteText) {
			el.editor.value = notes.remoteText;
			if (!el.preview.hidden) renderPreview();
		}
		notes.dirty = false;
		setSaveState('idle');
	}
	return r;
}

const scheduleSave = debounce(() => saveNotes(), AUTOSAVE_MS);

async function saveNotes() {
	if (notes.saving) { scheduleSave(); return; }
	const payload = el.editor.value;
	notes.saving = true;
	setSaveState('saving');
	try {
		await jput('/api/notes', { markdown: payload });
		notes.saving = false;
		notes.remoteText = payload;
		if (el.editor.value === payload) {
			notes.dirty = false;
			setSaveState('idle');
		} else {
			setSaveState('dirty');
		}
		// PUT does not return the new mtime, so refresh it — otherwise the next
		// poll would read our own write as a remote change.
		try {
			const r = await api('/api/notes');
			notes.remoteMtime = r.mtime ?? null;
			notes.remoteText = r.markdown || '';
		} catch (e) { /* non-fatal */ }
	} catch (e) {
		notes.saving = false;
		notes.dirty = true;
		setSaveState('error', `save failed: ${e.message} — your text is still here, retry when the daemon is back`);
	}
}

el.editor.addEventListener('input', () => {
	notes.dirty = true;
	setSaveState('dirty');
	if (!el.preview.hidden) renderPreview();
	scheduleSave();
});

el.editor.addEventListener('blur', () => { if (notes.dirty) scheduleSave.now(); });

$('#retrySave').addEventListener('click', () => saveNotes());

function renderPreview() {
	el.preview.innerHTML = mdRender(el.editor.value);
}

$('#previewBtn').addEventListener('click', () => {
	const showing = !el.preview.hidden;
	if (showing) {
		el.preview.hidden = true;
		el.editor.hidden = false;
		$('#previewBtn').textContent = 'preview';
	} else {
		renderPreview();
		el.preview.hidden = false;
		el.editor.hidden = true;
		$('#previewBtn').textContent = 'edit';
	}
});

$('#conflictMine').addEventListener('click', () => {
	el.conflict.hidden = true;
	notes.theirs = null;
	saveNotes();          // our buffer wins; overwrite disk
});

$('#conflictTheirs').addEventListener('click', () => {
	if (notes.theirs != null) {
		el.editor.value = notes.theirs.markdown || '';
		notes.remoteMtime = notes.theirs.mtime ?? null;
		notes.remoteText = el.editor.value;
		if (!el.preview.hidden) renderPreview();
	}
	notes.theirs = null;
	notes.dirty = false;
	el.conflict.hidden = true;
	setSaveState('idle');
});

setInterval(async () => {
	if (notes.saving) return;
	try {
		const r = await api('/api/notes');
		const changed = String(r.mtime) !== String(notes.remoteMtime);
		if (!notes.dirty && document.activeElement !== el.editor) {
			notes.remoteMtime = r.mtime ?? null;
			notes.remoteText = r.markdown || '';
			if (el.editor.value !== notes.remoteText) {
				el.editor.value = notes.remoteText;
				if (!el.preview.hidden) renderPreview();
			}
		} else if (changed && (r.markdown || '') !== el.editor.value) {
			// never clobber a dirty buffer — ask
			notes.theirs = r;
			el.conflict.hidden = false;
		}
	} catch (e) { /* daemon down; the poll will retry */ }
}, NOTES_POLL_MS);

/* ══════════════════════════ command bar ══════════════════════════ */

const history_ = [];
let histIdx = -1;

el.cmdBar.addEventListener('submit', async (e) => {
	e.preventDefault();
	const data = el.cmdText.value;
	const port = el.cmdPort.value;
	if (!data.trim() || !port) return;
	history_.push(data);
	histIdx = history_.length;
	el.cmdText.value = '';
	state.autoScroll = true;
	scrollToBottom();
	try {
		// author matters: reading a session back, "who typed this" changes how
		// everything after it is interpreted.
		await jpost('/api/send', { port, data, newline: '\r\n', annotate: true, author: 'user' });
		// the resulting `command` annotation arrives over the stream
	} catch (err) {
		el.cmdText.value = data;
		setConn('down', `send failed: ${err.message}`);
		setTimeout(() => setConn(state.esConnected ? 'live' : 'down', state.esConnected ? 'live' : 'offline'), 3000);
	}
});

el.cmdText.addEventListener('keydown', (e) => {
	if (e.key === 'ArrowUp') {
		if (!history_.length) return;
		e.preventDefault();
		histIdx = Math.max(0, histIdx - 1);
		el.cmdText.value = history_[histIdx] || '';
		el.cmdText.setSelectionRange(el.cmdText.value.length, el.cmdText.value.length);
	} else if (e.key === 'ArrowDown') {
		if (!history_.length) return;
		e.preventDefault();
		histIdx = Math.min(history_.length, histIdx + 1);
		el.cmdText.value = histIdx >= history_.length ? '' : history_[histIdx];
	}
});

/* ══════════════════════════ filter bar wiring ══════════════════════════ */

el.filter.addEventListener('input', debounce(() => {
	buildFilter(el.filter.value);
	refilter();
}, 90));

$('#levelToggles').addEventListener('click', (e) => {
	const b = e.target.closest('.tg');
	if (!b) return;
	const lvl = b.dataset.level;
	if (state.lvlOff.has(lvl)) { state.lvlOff.delete(lvl); b.classList.add('on'); }
	else { state.lvlOff.add(lvl); b.classList.remove('on'); }
	refilter();
});

el.srcTogs.addEventListener('click', (e) => {
	const b = e.target.closest('.tg');
	if (!b) return;
	const s = b.dataset.src;
	if (state.srcOff.has(s)) { state.srcOff.delete(s); b.classList.add('on'); }
	else { state.srcOff.add(s); b.classList.remove('on'); }
	refilter();
});

el.jump.addEventListener('keydown', (e) => {
	if (e.key !== 'Enter') return;
	e.preventDefault();
	const n = Number(el.jump.value.replace(/[^\d]/g, ''));
	if (n > 0) scrollToSeq(n, { setHash: true });
});

/* ══════════════════════════ log interactions ══════════════════════════ */

/**
 * Clear the log view. Client-side only: the daemon's store and JSONL are
 * untouched, so `logscope` queries and a page reload still see full history.
 * Raising dropCutoff to head is what makes this stick — gap-fill and SSE
 * replay would otherwise repopulate everything on the next reconnect.
 */
function clearLog() {
	flush();          // drain anything queued this frame so it can't resurface
	if (state.head > state.dropCutoff) state.dropCutoff = state.head;
	state.clearCutoff = state.head;
	closeComposer();
	for (const it of state.items) it.el.remove();
	state.items = [];
	state.seqSeen.clear();
	state.totalLines = 0;
	state.visLines = 0;
	state.newCount = 0;
	el.pill.hidden = true;
	state.autoScroll = true;
	updateCount();
	// Annotations anchored to cleared lines are cleared with them — from the
	// side list too. Their ids stay in annIds so a refetch can't bring them
	// back. (null-seq guard: null <= n is true in JS.)
	state.anns = state.anns.filter(a => !(typeof a.seq === 'number' && a.seq <= state.clearCutoff));
	state.pendingAnns = state.pendingAnns.filter(p => p.seq > state.clearCutoff);
	renderAnnList();
}

$('#clearBtn').addEventListener('click', clearLog);

el.list.addEventListener('click', (e) => {
	const act = e.target.dataset && e.target.dataset.act;
	const row = e.target.closest('.ln');
	if (!row) return;
	const seq = Number(row.dataset.seq);

	if (act === 'note') { openComposer(seq, row); return; }
	if (act === 'perma') {
		history.replaceState(null, '', `#seq=${seq}`);
		try { navigator.clipboard.writeText(location.href); } catch (err) {}
		flash(row);
		return;
	}
});

el.scroll.addEventListener('scroll', () => {
	const bottom = isAtBottom();
	if (bottom) {
		state.autoScroll = true;
		state.newCount = 0;
		el.pill.hidden = true;
	} else {
		state.autoScroll = false;
	}
});

el.pill.addEventListener('click', () => {
	state.autoScroll = true;
	state.newCount = 0;
	el.pill.hidden = true;
	scrollToBottom();
});

window.addEventListener('hashchange', () => {
	const n = hashSeq();
	if (n) scrollToSeq(n);
});

/* ══════════════════════════ tabs / split / theme ══════════════════════════ */

function setTab(name) {
	$$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
	$('#paneKnowledge').classList.toggle('active', name === 'knowledge');
	$('#paneAnnotations').classList.toggle('active', name === 'annotations');
	localStorage.setItem(LS.tab, name);
	if (name === 'annotations') renderAnnList();
}

$('#tabs').addEventListener('click', (e) => {
	const t = e.target.closest('.tab');
	if (t) setTab(t.dataset.tab);
});

/* On phones the split collapses to one pane at a time; the switcher is
   display:none on desktop, so this state is inert there. Asking the switcher
   whether it is laid out keeps the breakpoint in one place — the stylesheet. */
function mobileView() {
	return $('#viewSwitch').offsetParent !== null;
}

function setView(name) {
	const v = name === 'side' ? 'side' : 'log';
	document.body.dataset.view = v;
	$$('.vsw-b').forEach(b => b.classList.toggle('on', b.dataset.view === v));
	localStorage.setItem(LS.view, v);
	if (v === 'side') {
		if (localStorage.getItem(LS.tab) === 'annotations') renderAnnList();
	} else if (state.autoScroll) {
		// a hidden scroller loses scrollTop in some browsers — re-pin the tail
		requestAnimationFrame(scrollToBottom);
	}
}

$('#viewSwitch').addEventListener('click', (e) => {
	const b = e.target.closest('.vsw-b');
	if (b) setView(b.dataset.view);
});

function setSplit(pct) {
	const v = Math.min(88, Math.max(28, pct));
	document.documentElement.style.setProperty('--split', v.toFixed(2) + '%');
	localStorage.setItem(LS.split, String(v));
}

(function initDivider() {
	const div = $('#divider');
	let dragging = false;
	const onMove = (e) => {
		if (!dragging) return;
		const rect = $('#split').getBoundingClientRect();
		setSplit(((e.clientX - rect.left) / rect.width) * 100);
	};
	const stop = () => {
		if (!dragging) return;
		dragging = false;
		div.classList.remove('dragging');
		document.body.classList.remove('resizing');
	};
	div.addEventListener('pointerdown', (e) => {
		dragging = true;
		div.classList.add('dragging');
		document.body.classList.add('resizing');
		div.setPointerCapture(e.pointerId);
	});
	div.addEventListener('pointermove', onMove);
	window.addEventListener('pointermove', onMove);
	div.addEventListener('pointerup', stop);
	window.addEventListener('pointerup', stop);
	div.addEventListener('dblclick', () => setSplit(65));
})();

function setTheme(t) {
	document.documentElement.dataset.theme = t;
	localStorage.setItem(LS.theme, t);
}

$('#themeBtn').addEventListener('click', () => {
	setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

/* ══════════════════════════ keyboard ══════════════════════════ */

let lastKey = '', lastKeyAt = 0;

window.addEventListener('keydown', (e) => {
	const t = e.target;
	const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

	if (e.key === 'Escape') {
		if (!el.devMenu.hidden) { el.devMenu.hidden = true; return; }
		if (composer.node) { closeComposer(); return; }
		if (typing && t === el.filter) { el.filter.value = ''; buildFilter(''); refilter(); el.filter.blur(); return; }
		if (typing) { t.blur(); return; }
		if (el.filter.value) { el.filter.value = ''; buildFilter(''); refilter(); }
		return;
	}
	if (typing) return;
	if (e.metaKey || e.ctrlKey || e.altKey) return;

	if (e.key === '/') { e.preventDefault(); el.filter.focus(); el.filter.select(); return; }

	if (e.key === 'n') {
		e.preventDefault();
		const cur = localStorage.getItem(LS.tab) === 'annotations' ? 'annotations' : 'knowledge';
		setTab(cur === 'knowledge' ? 'annotations' : 'knowledge');
		return;
	}

	if (e.key === 'G') {
		e.preventDefault();
		state.autoScroll = true;
		state.newCount = 0;
		el.pill.hidden = true;
		scrollToBottom();
		return;
	}

	if (e.key === 'g') {
		const now = Date.now();
		if (lastKey === 'g' && now - lastKeyAt < 600) {
			e.preventDefault();
			state.autoScroll = false;
			el.scroll.scrollTop = 0;
			lastKey = '';
			return;
		}
		lastKey = 'g';
		lastKeyAt = now;
		return;
	}
	lastKey = e.key;
	lastKeyAt = Date.now();
});

/* ══════════════════════════ boot ══════════════════════════ */

async function boot() {
	setTheme(localStorage.getItem(LS.theme) === 'light' ? 'light' : 'dark');
	const sp = Number(localStorage.getItem(LS.split));
	setSplit(isFinite(sp) && sp > 0 ? sp : 65);
	setTab(localStorage.getItem(LS.tab) === 'annotations' ? 'annotations' : 'knowledge');
	setView(localStorage.getItem(LS.view) === 'side' ? 'side' : 'log');
	setConn('idle', 'offline');
	buildFilter('');
	updateCount();

	try { await loadNotes(true); }
	catch (e) { setSaveState('error', `could not load knowledge.md: ${e.message}`); }

	await loadBacklog();
	renderAnnList();

	const target = hashSeq();
	if (target) {
		// backlog is in the DOM by now; flush() already ran inside loadBacklog
		requestAnimationFrame(() => scrollToSeq(target));
	}

	connect();
	setInterval(pollStatus, STATUS_POLL_MS);

	// Devices change when someone plugs in an adapter or frees a port, which is
	// rare — poll lazily, and skip the rebuild entirely when nothing moved so an
	// open dropdown is never yanked out from under the pointer.
	await refreshDevices();
	setInterval(refreshDevices, 5000);
}

boot();
