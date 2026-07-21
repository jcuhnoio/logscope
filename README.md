# logscope

Timestamped serial-log monitoring with inline agent annotations, a web UI, and
a durable per-project knowledge file.

It exists so that debugging hardware with an AI agent does not mean pasting
walls of serial output into a chat window. The daemon owns the port; the human
watches the stream in a browser; the agent queries it with a cursor and writes
its analysis back into the timeline at the point where each thing happened.

Zero runtime dependencies — Node 18+ and `stty`, nothing else.

## Quick start

```sh
mkdir -p <project>/.logscope
cat > <project>/.logscope/config.json <<'EOF'
{
  "port": 7717,
  "sources": [
    { "name": "board", "type": "serial",
      "device": "/dev/cu.usbserial-XXXX", "baud": 115200 }
  ],
  "mirror": "~/logs/board.txt",
  "commands": {
    "build": { "cmd": "make", "timeout": 900000 }
  }
}
EOF

logscope start --project <project>   # daemon + web UI on http://127.0.0.1:7717
logscope open                        # browser
```

Nothing device-specific is baked in. Log-format recognition is a configurable
stack of built-in presets plus your own regex rules; flashing, bootloader
dialogues and other hardware rituals are project scripts under
`.logscope/scripts/` (seeded empty, with the contract documented inside).
`examples/config.example.json` is a commented starting point and
`doc/CONFIG.md` the full reference.

The port must be free. logscope takes exclusive ownership so it can *send*, so
close any `tio`/`screen`/`minicom` first — it will name the holding process if
you forget.

## Two ways in

**The browser** is for the human: a split view with the timestamped log on the
left and knowledge/annotations on the right. Agent annotations render inline in
the log at their anchor point. You can send commands to the device from the
bottom bar and annotate any line yourself.

**The CLI** is for the agent, and its output is shaped for a token budget:

```sh
logscope wait --pattern 'BootNotification.*Accepted' --timeout 90
logscope summary --since 18422
logscope grep 'socket \d+ closed' --level err
logscope send "ocpp" --wait 'cs CONNECTED|DISCONNECTED'
logscope run flash
logscope note --kind analysis --seq 18422 "This CEREG=2 is a re-attach, not a failure"
```

Every read command prints a trailing `head=N` / `cursor=N`. Pass it back as
`--since` and you only ever see what is new. `wait` blocks server-side and
returns the matching line plus context — a few dozen tokens for an event that
took ten thousand log lines to arrive.

`run` executes an external step (build, flash, a server-side trigger) and
anchors it in the same timeline as the serial log, so cause and effect line up
for whoever reads the session later.

## Sources

- `serial` — logscope owns the tty. Readable and writable.
- `file` — tails a growing log file. Read-only, but coexists with a terminal
  that already owns the port, and can pull in non-serial inputs (CI output, a
  server log) onto the same timeline.

## Parsing

Raw lines become `{lvl, tag, msg, dev_ts}` through named built-in presets
(Zephyr's two formats, `uptime:LEVEL:module:` loggers, bracketed subsystem
tags, fault promotion) selected by `"parsers"` in config, plus custom regex
`"rules"` that always win. Omit `"parsers"` and every preset is tried,
most-specific first. A line nothing recognizes is kept raw, never dropped.

## Flashing

Three tiers, in order of how often they apply:

**Debug probe (OpenOCD, J-Link, probe-rs, pyocd, STM32CubeProgrammer…)** —
the common case, and the strongest one here: a probe flashes over SWD/JTAG and
never touches the UART, so a plain `commands` alias is all it takes. logscope
keeps the port open through the whole flash and catches the reset banner in
the same timeline as the command that caused it.

```json
"flash": { "cmd": "openocd -f board/st_nucleo_f4.cfg -c 'program build/app.elf verify reset exit'" }
```
```sh
logscope run flash && logscope wait --pattern 'Booting' --timeout 15
```

**External UART tool (esptool, mcumgr, avrdude…)** — these need the tty
itself, so the alias adds `detachPort`: logscope hands the port over, captures
the tool's stdout into the timeline, and takes the port back when it exits.

```json
"flash": { "cmd": "esptool --port {device} write_flash 0 build/app.bin", "detachPort": "board" }
```

**Native serial flashing (`logscope flash <image>`)** — for UART bootloaders
you'd otherwise drive by hand. The device-specific sequence is a small ES
module in `.logscope/scripts/` named by `flash.script` in config; logscope
supplies the raw-mode port, an XMODEM-1K engine, and annotation helpers, and
the whole bootloader dialogue lands in the timeline, byte for byte. No script
configured → `flash` refuses and points at the contract doc.

## Knowledge

`<project>/.logscope/knowledge.md` is the durable, human- and agent-editable
notes file: what the tags mean, which command drives which flow, what a healthy
boot looks like. It is the part that stops the setup being re-explained every
session. Edit it in the browser, or `logscope knowledge --append "..."`.

## On disk

```
.logscope/
  config.json
  knowledge.md
  daemon.log
  scripts/                         # device-specific automation (flash script…)
  sessions/<id>/lines.jsonl        # every line, structured
  sessions/<id>/annotations.jsonl
  sessions/<id>/runs/<id>.txt      # full output of each `logscope run`
  current -> sessions/<id>
```

Sessions are append-only JSONL, so any session is replayable and greppable long
after the fact.

## Platform notes

macOS serial is particular, and logscope works around it:
- Use the `cu.*` device node. A blocking open of a serial device hangs
  regardless of `clocal`, so the fd is `O_NONBLOCK` and reads are an explicit
  EAGAIN-aware poll loop — neither `fs.createReadStream` nor `net.Socket` can
  consume a non-blocking TTY fd.
- When the previous owner exits, the line reverts to its default baud, so the
  first quarter-second after `stty` is drained and discarded as garbage.

See `doc/API.md` for the HTTP contract.
