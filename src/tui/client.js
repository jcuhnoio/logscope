// Daemon transport for the TUI: JSON calls plus the SSE stream. Node 18 has
// no EventSource, and the protocol is small enough that a parser is cheaper
// than a dependency.

import http from "node:http";

export function makeApi(base) {
	return async function api(p, body, method) {
		const r = await fetch(base + p, {
			method: method ?? (body ? "POST" : "GET"),
			headers: body ? { "content-type": "application/json" } : undefined,
			body: body ? JSON.stringify(body) : undefined,
		});
		const j = await r.json().catch(() => ({ error: `non-JSON response (HTTP ${r.status})` }));
		if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
		return j;
	};
}

/**
 * Incremental SSE parser. Feed it chunks; it calls onEvent(name, data) per
 * complete event. Exported for tests.
 */
export function sseParser(onEvent) {
	let buf = "";
	let event = "message";
	let data = [];
	return (chunk) => {
		buf += chunk;
		let nl;
		while ((nl = buf.indexOf("\n")) >= 0) {
			let line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line === "") {
				if (data.length) onEvent(event, data.join("\n"));
				event = "message";
				data = [];
			} else if (line.startsWith("event:")) {
				event = line.slice(6).trim();
			} else if (line.startsWith("data:")) {
				data.push(line.slice(5).replace(/^ /, ""));
			}
		}
	};
}

/**
 * Keep an SSE connection to /api/stream open, resuming from `cursor()` on
 * every reconnect so a daemon restart or a dropped socket loses nothing the
 * daemon still holds in memory.
 */
export function openStream(base, { cursor, onEvent, onState }) {
	let req = null;
	let timer = null;
	let closed = false;
	let delay = 500;
	let gen = 0;

	const connect = () => {
		if (closed) return;
		const my = ++gen;
		// A destroyed socket can still deliver end/error after its successor
		// connected; only the current generation may trigger a retry.
		const retryIfCurrent = (why) => my === gen && retry(why);
		onState("connecting");
		const url = `${base}/api/stream?from=${cursor()}`;
		req = http.get(url, (res) => {
			if (res.statusCode !== 200) {
				res.resume();
				return retryIfCurrent(`HTTP ${res.statusCode}`);
			}
			delay = 500;
			onState("live");
			res.setEncoding("utf8");
			const feed = sseParser((name, raw) => {
				let data;
				try {
					data = JSON.parse(raw);
				} catch {
					return;
				}
				onEvent(name, data);
			});
			res.on("data", feed);
			res.on("end", () => retryIfCurrent("stream ended"));
			res.on("error", (e) => retryIfCurrent(e.message));
		});
		req.on("error", (e) => retryIfCurrent(e.code === "ECONNREFUSED" ? "daemon not running" : e.message));
	};

	const retry = (why) => {
		if (closed || timer) return;
		req?.destroy();
		onState("down", why);
		timer = setTimeout(() => {
			timer = null;
			connect();
		}, delay);
		delay = Math.min(delay * 2, 5000);
	};

	connect();
	return {
		close() {
			closed = true;
			clearTimeout(timer);
			req?.destroy();
		},
	};
}
