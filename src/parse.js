// Line parsing: turn a raw serial line into structured fields.
//
// Nothing about a log format is hard-coded into the pipeline. Parsing is a
// stack of *presets* — named, built-in recognizers for common firmware log
// shapes — plus user regex rules from config.json. Config picks the stack:
//
//   "parsers": ["zephyr", "faults"]        // just these, in this order
//   "parsers": []                          // raw passthrough (rules still run)
//   (omitted)                              // all presets, most-specific first
//
// A source entry may carry its own "parsers", overriding the global list.
//
// Whatever the stack, a line that matches nothing falls through with lvl/tag
// null and msg === raw. Never drop a line just because it didn't parse —
// unparsed output (bootloader banners, XMODEM chatter, panic dumps) is usually
// the interesting part.

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

// [hh:mm:ss.mmm(,uuu)] <lvl> tag: message         — Zephyr's default format
const ZEPHYR =
	/^\[(\d{2}:\d{2}:\d{2}\.\d{3}(?:,\d{3})?)\]\s*<(err|wrn|inf|dbg)>\s*([\w.\-/]+):\s?(.*)$/;

// Same, but no level/tag — printk() and friends.
const ZEPHYR_BARE = /^\[(\d{2}:\d{2}:\d{2}\.\d{3}(?:,\d{3})?)\]\s?(.*)$/;

// "490941:INFO:null: message" — uptime in ms, an upper-case level word, and a
// module slot some loggers print as the literal "null" when it is unset.
const MS_LEVEL =
	/^(\d{1,12}):(E|W|I|D|ERR|WRN|INF|DBG|ERROR|WARN|WARNING|INFO|DEBUG|FATAL):([\w.\-/]*):\s?(.*)$/i;

// A leading "module: " on a message whose own tag slot came back empty. Needs a
// bare identifier, so "ocpp rx [3,…]" (a space before the colon) stays put.
const PREFIX_TAG = /^([A-Za-z][\w.\-]{0,15}):\s(.*)$/;

// Level without a timestamp (timestamping disabled, or a wrapped line).
const LEVEL_ONLY = /^<(err|wrn|inf|dbg)>\s*([\w.\-/]+):\s?(.*)$/;

// "[NBIOT] TX AT+CEREG?" — a bracketed subsystem prefix printed by the app.
const BRACKET_TAG = /^\[([A-Za-z][\w.\-]{0,15})\]\s?(.*)$/;

// Unlevelled output that is nonetheless a crash. Deliberately does NOT include
// a bare "***": that also wraps boot banners, which are not errors.
const FAULTY =
	/(\b(BUS|MEM MANAGE|USAGE|HARD|MPU)\s+FAULT|\bFAULT\b.*\bhalt|PANIC|ASSERTION FAIL|Halting system|CPU exception|\bfatal error\b)/i;

const LEVEL_ALIASES = {
	e: "err", err: "err", error: "err", fatal: "err",
	w: "wrn", wrn: "wrn", warn: "wrn", warning: "wrn",
	i: "inf", inf: "inf", info: "inf",
	d: "dbg", dbg: "dbg", debug: "dbg",
};

/**
 * Built-in presets. Each is (clean, out) => boolean; `true` means the line is
 * fully claimed and the stack stops. A preset may also enrich `out` and return
 * false to let later presets keep looking (bracket-tag, faults).
 */
const PRESETS = {
	// [00:04:12.881] <inf> ocpp: message
	zephyr(clean, out) {
		const m = clean.match(ZEPHYR);
		if (!m) return false;
		out.dev_ts = m[1];
		out.lvl = m[2];
		out.tag = m[3];
		out.msg = m[4];
		return true;
	},

	// 490941:INFO:null: message  (lifts a leading "module: " when tag is unset)
	"uptime-level"(clean, out) {
		const m = clean.match(MS_LEVEL);
		if (!m) return false;
		out.dev_ts = m[1];
		out.lvl = normLevel(m[2]);
		out.tag = m[3] && m[3].toLowerCase() !== "null" ? m[3] : null;
		out.msg = m[4];
		if (!out.tag) {
			const p = out.msg.match(PREFIX_TAG);
			if (p) {
				out.tag = p[1];
				out.msg = p[2];
			}
		}
		return true;
	},

	// <inf> tag: message (no timestamp)
	"level-only"(clean, out) {
		const m = clean.match(LEVEL_ONLY);
		if (!m) return false;
		out.lvl = m[1];
		out.tag = m[2];
		out.msg = m[3];
		return true;
	},

	// [00:04:12.881] message — timestamp but no level; lifts "[TAG] msg" and
	// promotes fault text, since nothing later in the stack will see this line.
	"zephyr-bare"(clean, out) {
		const m = clean.match(ZEPHYR_BARE);
		if (!m) return false;
		out.dev_ts = m[1];
		out.msg = m[2];
		const b = out.msg.match(BRACKET_TAG);
		if (b) {
			out.tag = b[1];
			out.msg = b[2];
		}
		if (FAULTY.test(m[2])) out.lvl = "err";
		return true;
	},

	// [TAG] message — enriches and keeps going, so `faults` can still level it.
	"bracket-tag"(clean, out) {
		const m = clean.match(BRACKET_TAG);
		if (!m) return false;
		out.tag = m[1];
		out.msg = m[2];
		return false;
	},

	// Promote unlevelled crash output (FAULT/PANIC/ASSERT…) to err.
	faults(clean, out) {
		if (!out.lvl && FAULTY.test(clean)) out.lvl = "err";
		return false;
	},
};

export const PRESET_ORDER = [
	"zephyr",
	"uptime-level",
	"level-only",
	"zephyr-bare",
	"bracket-tag",
	"faults",
];

/**
 * Build a parse function from a preset list + compiled user rules.
 * User rules always run first — config beats built-ins.
 *
 * @param {object} opts
 * @param {string[]|null} [opts.presets]  preset names in match order;
 *                                        null/undefined → all of PRESET_ORDER
 * @param {object[]} [opts.rules]         output of compileRules()
 */
export function makeParser({ presets, rules = [] } = {}) {
	const names = presets == null ? PRESET_ORDER : presets;
	const fns = names.map((n) => {
		const f = PRESETS[n];
		if (!f) {
			throw new Error(
				`unknown parser preset "${n}" — available: ${PRESET_ORDER.join(", ")}`
			);
		}
		return f;
	});

	return function parse(raw) {
		// Strip ANSI, CRs, and stray control bytes. Serial lines routinely carry
		// NULs during a modem reset or a baud glitch; they render as garbage and
		// break JSON round-tripping, but the surrounding text is worth keeping.
		const clean = stripAnsi(raw)
			.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
			.replace(/\s+$/, "");
		const out = { raw: clean, lvl: null, tag: null, msg: clean, dev_ts: null };
		if (!clean) return out;

		for (const rule of rules) {
			const m = clean.match(rule._compiled);
			if (!m) continue;
			const pick = (v) =>
				v == null ? null : typeof v === "string" && v.startsWith("=")
					? v.slice(1)
					: (m[v] ?? null);
			out.lvl = normLevel(pick(rule.lvl));
			out.tag = pick(rule.tag);
			out.msg = pick(rule.msg) ?? clean;
			out.dev_ts = pick(rule.ts);
			return out;
		}

		for (const fn of fns) {
			if (fn(clean, out)) break;
		}
		return out;
	};
}

export function stripAnsi(s) {
	return s.replace(ANSI, "");
}

// Legacy convenience: parse with every preset. Sources built through the
// server always get a makeParser() product instead.
const defaultParse = makeParser({});
export function parseLine(raw, extra = []) {
	return extra.length ? makeParser({ rules: extra })(raw) : defaultParse(raw);
}

function normLevel(v) {
	if (!v) return null;
	return LEVEL_ALIASES[String(v).toLowerCase()] ?? null;
}

export function compileRules(rules = []) {
	return rules.map((r) => ({
		...r,
		_compiled: new RegExp(r.re, r.flags ?? ""),
	}));
}

/**
 * Collapse a line into a shape key so repeated-but-varying errors dedupe:
 * digits, hex blobs and quoted strings become placeholders.
 */
export function shapeKey(line) {
	return (line.msg || line.raw)
		.replace(/0x[0-9a-fA-F]+/g, "#")
		.replace(/\b\d+\b/g, "#")
		.replace(/"[^"]*"/g, '"…"')
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 160);
}
