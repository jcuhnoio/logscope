# .logscope/config.json — the complete reference

Everything device-specific lives here (and in `.logscope/scripts/`), not in
logscope. One file per monitored project, hot-reloaded where noted.

```json
{
  "port": 7717,
  "sources": [ … ],
  "parsers": null,
  "rules": [ … ],
  "mirror": "~/logs/board.txt",
  "commands": { … },
  "flash": { … }
}
```

Keys prefixed with `_` anywhere in the file are comments — JSON has none of
its own.

## `port`

HTTP port for the daemon + web UI. Default `7717`. Loopback only, no auth.
`LOGSCOPE_PORT` overrides for the CLI side.

## `sources`

The inputs on the timeline. Each needs a unique `name` — it becomes `src` on
every line.

```json
{ "name": "board",  "type": "serial", "device": "/dev/cu.usbserial-XXXX", "baud": 115200 }
{ "name": "server", "type": "file",   "file": "~/logs/server.log", "from": "end" }
```

- `serial` — logscope owns the tty exclusively; readable *and* writable
  (`logscope send`, `/api/send`, flashing).
- `file` — `tail -F`-style follow; read-only, coexists with whatever writes
  the file. `from`: `"end"` (default, only new output) or `"start"` (replay).

A source may carry its own `parsers` and/or `rules`, overriding/extending the
global ones below. Sources do **not** hot-reload — re-opening a tty
mid-session is deliberate and manual (`/api/attach`, or the device picker in
the web UI).

## `parsers` — built-in format presets

How raw lines become `{lvl, tag, msg, dev_ts}`. Named presets, tried in the
order given, first claim wins:

| preset | matches |
|---|---|
| `zephyr` | `[00:04:12.881] <inf> ocpp: message` |
| `uptime-level` | `490941:INFO:null: message` (lifts a leading `module:` when the tag slot is `null`) |
| `level-only` | `<inf> ocpp: message` |
| `zephyr-bare` | `[00:04:12.881] message` (also lifts `[TAG]`, promotes fault text) |
| `bracket-tag` | `[NBIOT] message` (enriches, keeps matching) |
| `faults` | promotes unlevelled `FAULT/PANIC/ASSERT…` lines to `err` |

- omitted / `null` — every preset, in the order above. Fine default: presets
  are mutually exclusive enough that auto works for mixed output.
- `["zephyr", "faults"]` — exactly these.
- `[]` — raw passthrough (custom `rules` still apply).

A line nothing claims falls through with `lvl`/`tag` null and `msg === raw` —
lines are never dropped for failing to parse.

## `rules` — custom regex parsing

Run before any preset; config beats built-ins. Each rule:

```json
{
  "re": "^(\\d+)ms \\[(\\w+)\\] (ERR|WRN|INF|DBG) (.*)$",
  "flags": "",
  "ts": 1, "tag": 2, "lvl": 3, "msg": 4
}
```

`ts`/`lvl`/`tag`/`msg` are 1-based capture-group indices, or literal strings
prefixed with `=` (e.g. `"tag": "=modem"`). `lvl` is normalized
(`ERROR`/`E`/`fatal` → `err`, etc.).

## `mirror`

Optional plain-text mirror of every line, tio-style, for people who already
`tail`/grep a log file. `~` expands.

## `commands` — run aliases *(hot-reloaded)*

Named shell commands for `logscope run <name>` / `/api/run`, so long
invocations stay out of the agent's context. String or object form:

```json
"build": { "cmd": "make -j8", "timeout": 900000, "label": "make", "cwd": null },
"flash": {
  "cmd": "openocd -f interface/jlink.cfg -f target/nrf52.cfg -c 'program build/app.elf verify reset exit'",
  "timeout": 300000
},
"flash-uart": {
  "cmd": "esptool --port {device} --baud 460800 write_flash 0 build/app.bin",
  "detachPort": "board",
  "timeout": 600000
}
```

- A **debug-probe flasher** (OpenOCD, J-Link Commander, probe-rs, pyocd) is
  just an alias — it works over SWD/JTAG, so logscope keeps the UART open and
  the reset banner lands in the timeline right after the flash command.
- `detachPort` hands the tty to the command and takes it back after — needed
  only for tools that flash *over the UART itself* (esptool, mcumgr, avrdude).
- `{device}` / `{baud}` are substituted from the live source named by
  `detachPort`, so aliases never hardcode a tty path that goes stale.
- Anything after the alias on the command line is appended:
  `logscope run build V=1`.

## `flash` — native serial flashing *(hot-reloaded)*

For UART bootloaders you would otherwise drive by hand in a terminal. If your
board flashes via a debug probe or an existing CLI tool, you don't need this —
use a `commands` alias (above) and skip this section.

`logscope flash <image>` runs an ES module you provide; nothing about any
particular bootloader is built in. Without this key, `flash` refuses with a
pointer here. What it buys over `detachPort`: logscope never releases the
port, so the bootloader dialogue and transfer progress are annotated inline
instead of buried in another tool's stdout.

```json
"flash": {
  "script": "scripts/flash.mjs",
  "promptTimeout": 20000
}
```

Name the script `.mjs` — Node decides module type per-file, and a bare `.js`
inside a non-Node project directory is parsed as CommonJS, where `export`
fails. `script` resolves relative to `.logscope/` then the project root. Every other
key in the object is passed to the script as defaults (`ctx.opts`), overridden
by per-call options. The script contract is documented in
`.logscope/scripts/README.md` (seeded on first daemon start) — in short:

```js
export default async function flash({ port, data, file, note, echo, xmodem, opts }) {
  // drive port.write / port.rawReadUntil, annotate with note(),
  // send with xmodem() if the protocol is XMODEM-1K, throw on failure
  return { confirmed: true };
}
```

Script edits are picked up on the next flash; no restart.
