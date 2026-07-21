// Who is holding a serial device?
//
// macOS reports EBUSY with no hint of the culprit, and the answer is almost
// always a forgotten tio/screen in another window — worth asking lsof so the
// error can name it.
//
// Two traps, both of which silently defeated an earlier execFileSync version:
//
//  1. lsof exits non-zero whenever it merely *warns* about something it could
//     not stat, so a throw-on-nonzero call loses perfectly good stdout. Read
//     stdout regardless of exit status.
//  2. A device has two nodes — /dev/cu.X (callout) and /dev/tty.X (dialin) —
//     and a holder of either blocks the other. Ask about both.

import { spawnSync } from "node:child_process";

export function whoHolds(device) {
	const base = device.replace(/^\/dev\/(cu|tty)\./, "");
	const candidates = base === device ? [device] : [`/dev/cu.${base}`, `/dev/tty.${base}`];

	const r = spawnSync("lsof", ["-n", ...candidates], {
		encoding: "utf8",
		timeout: 4000,
	});
	const out = r.stdout || "";
	for (const line of out.split("\n")) {
		if (!line || line.startsWith("COMMAND")) continue;
		const f = line.trim().split(/\s+/);
		if (f.length < 2 || !/^\d+$/.test(f[1])) continue;
		if (f[1] === String(process.pid)) continue; // that's us
		return `${f[0]} (pid ${f[1]})`;
	}
	return null;
}
