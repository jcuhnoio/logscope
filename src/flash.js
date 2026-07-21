// Firmware flash over UART, driven inside logscope — so a flash does not
// require handing the tty to another process: logscope keeps the port, and the
// bootloader dialogue, transfer progress, and post-reset boot log all land in
// one timeline with consistent timestamps.
//
// The *sequence* (which commands enter the bootloader, what the prompt looks
// like, which protocol carries the image) is entirely device-specific, so none
// of it lives here. It comes from a flash script: an ES module named by
// `flash.script` in .logscope/config.json, usually kept in .logscope/scripts/.
//
// Script contract — export default async ({ ...ctx }) => result:
//
//   ctx.port     the serial source, already in raw mode:
//                  write(str) · rawFlush() · rawReadUntil(text, ms, echo)
//   ctx.data     Buffer — the firmware image
//   ctx.file     absolute path it was read from
//   ctx.note     (kind, text, meta?) → annotation in the timeline
//   ctx.echo     (text) → mirror device output into the log
//   ctx.xmodem   (data, opts) → XMODEM-1K send over ctx.port
//   ctx.store    the session store (rarely needed directly)
//   ctx.opts     flash config from config.json merged with per-call options
//
// Return an object (merged into the API response); throw on failure. Raw-mode
// acquire/release is handled HERE, in a try/finally — a crashing script must
// never leave the log permanently silent.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sendXmodem } from "./xmodem.js";

export async function flashFirmware({ port, file, store, cfg, opts = {} }) {
	const profile = cfg?.flash;
	if (!profile?.script) {
		throw new Error(
			"no flash script configured — set flash.script in .logscope/config.json " +
				"(the script contract is described in .logscope/scripts/README.md)"
		);
	}

	// Resolve: absolute → relative to .logscope/ → relative to the project.
	const candidates = path.isAbsolute(profile.script)
		? [profile.script]
		: [path.join(cfg._dir, profile.script), path.join(cfg._project, profile.script)];
	const scriptPath = candidates.find((p) => fs.existsSync(p));
	if (!scriptPath) {
		throw new Error(`flash script not found: ${profile.script} (tried ${candidates.join(", ")})`);
	}

	const abs = path.resolve(file);
	if (!fs.existsSync(abs)) throw new Error(`no such file: ${abs}`);
	const data = fs.readFileSync(abs);
	if (!data.length) throw new Error(`${abs} is empty`);

	// Import with an mtime cache-buster: flash scripts get edited mid-bring-up
	// far more often than the daemon is restarted, and a stale module fails the
	// same way a stale command alias does — successfully, at the old behaviour.
	const mtime = fs.statSync(scriptPath).mtimeMs;
	const mod = await import(`${pathToFileURL(scriptPath).href}?v=${mtime}`);
	const run = mod.default ?? mod.flash;
	if (typeof run !== "function") {
		throw new Error(`${scriptPath} does not export a default flash function`);
	}

	const t0 = Date.now();
	const author = opts.author ?? "claude";
	const note = (kind, text, meta = {}) =>
		store.addAnnotation({ kind, author, text, meta: { flash: true, ...meta } });

	// Mirror the device's own words into the log, so the handshake is on the
	// record rather than hidden inside the script.
	const echo = (text) => {
		for (const line of text.split(/\r*\n|\r/)) {
			const s = line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim();
			if (s) store.addLine({ src: port.name, raw: s, msg: s, tag: "boot" });
		}
	};

	note("mark", `flash: ${path.basename(abs)} (${data.length.toLocaleString()} B)`, {
		label: `flash ${path.basename(abs)}`,
		file: abs,
		bytes: data.length,
		script: scriptPath,
	});

	port.acquireRaw();
	try {
		const r = await run({
			port,
			data,
			file: abs,
			store,
			note,
			echo,
			xmodem: (d, o = {}) => sendXmodem(port, d, o),
			opts: { ...profile, ...opts },
		});
		return { ok: true, file: abs, bytes: data.length, ms: Date.now() - t0, ...r };
	} finally {
		// Always hand the port back to the line parser, including on failure —
		// otherwise the log goes permanently silent after a botched flash.
		port.releaseRaw();
	}
}
