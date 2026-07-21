---
name: logscope
description: Observe and drive a device's serial logs without pasting them into chat. Use whenever the task involves watching firmware/device output, waiting for something to happen on hardware, sending CLI commands to a board, or running a flash/OTA/test flow and checking whether it worked. Triggers on "watch the logs", "did it boot", "is it connected", "send X to the device", "run the firmware update", "what happened on the board".
---

# logscope

A local daemon owns the serial port, timestamps every line, and stores them
under a monotonically increasing `seq`. You query it. **Log volume never enters
your context unless you ask for specific lines.**

The human watches the same stream in a browser, with your annotations rendered
inline at the exact point in the log where you made them.

## Before anything else

```
logscope status          # is the daemon up, which sources, current head seq
logscope knowledge       # what we already know about THIS system
```

`logscope knowledge` is the durable per-project notes file. **Read it first and
trust it** — it exists so the human does not have to re-explain the setup every
session. When you learn something that will still be true next week, write it
back (`logscope knowledge --append "..."`). Session-specific noise does not
belong there; use `logscope note` for that.

## The cursor discipline — this is the whole point

Every read command prints a trailing `head=N` or `cursor=N`. **Keep that number
and pass it as `--since` on the next call.** You then only ever see what is new.
Without this you re-read the same thousand lines every turn and burn the budget
for nothing.

```
logscope summary                     # → head=18422
# ... do something ...
logscope summary --since 18422       # only what happened since
```

## Reading, cheapest first

Reach for these in order. Do not skip to `tail`.

| Want | Use |
|---|---|
| "wait until X happens" | `logscope wait --pattern RE --timeout 120` |
| "what happened while I was away" | `logscope summary --since N` |
| "find every occurrence of X" | `logscope grep RE --since N` |
| "I don't know what I'm looking for" | `logscope tail -n 60` |

**`wait` is the primary tool.** It blocks server-side and returns only the
matching line plus a few lines of context — a few dozen tokens for an event that
took four minutes and ten thousand log lines to arrive. Polling `tail` in a loop
is the wrong shape and costs ~100× more.

```
logscope wait --pattern 'BootNotification.*Accepted' --timeout 90
logscope wait --pattern 'FAULT|PANIC|Halting' --timeout 300   # watch for failure
```

Exit code 2 means it timed out — that is a real signal, not an error to retry
blindly. Ask why it did not happen.

`summary` gives you counts by level and tag plus deduplicated error lines. It is
the right way to answer "is anything wrong?" over a large range.

`tail` is the escape hatch for genuinely unknown failures. Use it deliberately,
bounded with `-n`, and prefer `--level err,wrn` to narrow it.

## Acting

```
logscope send "ocpp status" --wait 'endpoint|error' --timeout 10
logscope run flash                       # a named alias from .logscope/config.json
logscope run "make patched" --timeout 600
```

`send` writes to the device and can block for the reply in one round trip —
prefer that over `send` then a separate `wait`. It reports the cursor from
*before* the write, so the reply window is exact.

`run` executes an external step (flash script, CSMS trigger, build) and anchors
it in the same timeline as the serial log. **Use it instead of plain Bash for
anything whose effect shows up in the logs** — that is what makes cause and
effect line up for the human reading the web UI later.

## Annotating — do this as you go, not at the end

```
logscope mark "phase 2: OTA download"
logscope note "Download stalled 40s at 64KB — matches the NB-IoT keepalive bug"
logscope note --kind analysis --seq 18422 "This CEREG=2 is the modem re-attaching, not a failure"
```

Annotations anchor to a `seq` and render inline in the human's log view at that
point. This is the product: the log with your reasoning attached where it
happened. A run with no annotations is a wasted run — the human gets a wall of
text and no explanation.

Anchor to a specific `--seq` when commenting on a line you already saw. Omit it
to anchor at the current head.

## Working a hardware flow

1. `logscope knowledge` — load what we know.
2. `logscope mark "<what you are about to do>"`.
3. `logscope run <trigger>` or `logscope send <command>`.
4. `logscope wait --pattern <success> --timeout <realistic>` — and pass a
   pattern that also matches the *failure* shape, so you learn fast either way.
5. `logscope note` what you concluded, anchored where it happened.
6. If it was a durable lesson: `logscope knowledge --append`.

## Don'ts

- Don't `cat` or `tail -f` the raw log file. That is the thing this tool exists
  to prevent.
- Don't poll in a loop. Use `wait`.
- Don't re-read from seq 0. Use `--since`.
- Don't dump a large `tail` "to be safe". Use `summary` and then target it.
