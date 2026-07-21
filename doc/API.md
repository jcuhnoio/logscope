# logscope HTTP API contract

Daemon listens on `http://127.0.0.1:7717` by default (`LOGSCOPE_PORT`).
All request/response bodies are JSON unless stated. No auth (loopback only).

## Core types

### Line
A single received log line. `seq` is a monotonically increasing integer per
session, starting at 1. It is the universal cursor.

```json
{
  "seq": 18422,
  "t": 1753070000123,          // host wallclock ms at receipt
  "mono": 251344,              // ms since session start
  "src": "charger",            // logical port name
  "raw": "[00:04:12.881] <inf> ocpp: download complete 262144B",
  "lvl": "inf",                // err|wrn|inf|dbg|null  (parsed, may be null)
  "tag": "ocpp",               // module/subsystem (parsed, may be null)
  "msg": "download complete 262144B",  // message w/o prefix; == raw if unparsed
  "dev_ts": "00:04:12.881"     // device-reported timestamp, may be null
}
```

### Annotation
Anchored to a `seq` — it renders inline in the log at that point.

```json
{
  "id": "a-42",
  "seq": 18422,                // anchor: appears after this line
  "t": 1753070000500,
  "kind": "note",              // note|analysis|command|run|mark|error
  "author": "claude",          // claude|user
  "text": "Download finished. Next: expect checksum then CHIPRST.",
  "meta": {}                   // kind-specific, see below
}
```

`meta` by kind:
- `command` — `{"port":"charger","data":"ocpp status"}`
- `run` — `{"cmd":"...","cwd":"...","exit":0,"ms":1240,"stdout_tail":"..."}`
- `mark` — `{"label":"phase-2-download"}`

## Endpoints

### `GET /api/status`
```json
{ "sessionId":"2026-07-21T09-30-11", "startedAt":1753069811000, "head":18422,
  "ports":[{"name":"charger","device":"/dev/cu.usbserial-A10P20H6","type":"serial",
            "baud":115200,"connected":true,"lines":18422,"lastAt":1753070000123,
            "writable":true}],
  "commands":["build","flash"],
  "notes":"/…/.logscope/knowledge.md", "dir":"/…/sessions/<id>",
  "project":"/path/to/monitored/project" }
```

`writable` is false for `file` sources (a log tail cannot accept input) — a
send UI should offer only writable ports. `Line.src` and `ports[].name` are the
same namespace.

### `GET /api/lines`
Query: `from` (seq, exclusive, default 0), `to` (seq, inclusive), `limit`
(default 200, max 5000), `src`, `grep` (regex over `raw`), `level`
(csv e.g. `err,wrn`), `tag` (csv), `order` (`asc`|`desc`, default `asc`).

```json
{ "lines":[Line], "head":18422, "truncated":false }
```

### `GET /api/annotations`
Query: `from` (seq, exclusive), `to` (seq, inclusive) — same units and
half-open convention as `/api/lines`. No paging: annotations are low-volume by
construction. → `{ "annotations":[Annotation] }`

Annotations created via `POST /api/annotate` are echoed on `/api/stream`
verbatim — `text` is stored exactly as sent, never trimmed or normalized — so a
client may reconcile an optimistically-rendered annotation by content match.

### `GET /api/stream`  (Server-Sent Events)
Query: `from` (seq — replays from this cursor, then goes live).
Events:
- `event: line`       `data: Line`
- `event: annotation` `data: Annotation`
- `event: status`     `data: <status object>`
- `event: ping`       `data: {}`   (every 15s, keepalive)

### `POST /api/wait`
Long-polls until a line matches. This is the agent's primary read path.
```json
// request
{ "pattern":"BootNotification.*Accepted", "src":null, "since":18000,
  "timeout":60000, "context":3, "flags":"i" }
// response
{ "matched": Line|null, "before":[Line], "after":[Line],
  "cursor":18425, "elapsed_ms":251300, "timedOut":false }
```
`after` is best-effort: the server waits up to 300ms post-match to collect
trailing context. `cursor` = head at return; use it as the next `since`.

### `POST /api/summary`
Aggregate instead of dumping lines — cheap situational awareness.
```json
// request
{ "since":18000, "to":null, "src":null }
// response
{ "range":[18001,18422], "count":422,
  "byLevel":{"err":2,"wrn":11,"inf":409},
  "byTag":{"ocpp":84,"nbiot":210,"meter":44},
  "notable":[ {"seq":18310,"lvl":"err","raw":"...","count":2} ],
  "head":18422 }
```
`notable` = deduplicated err/wrn lines (normalized by stripping digits/hex),
newest-first, max 20, each with an occurrence `count`.

### `POST /api/annotate`
```json
{ "seq":null, "kind":"note", "author":"claude", "text":"...", "meta":{} }
```
`seq: null` anchors to current head. → the created Annotation.

### `POST /api/send`
Write to a serial port. Auto-creates a `command` annotation.
```json
{ "port":"charger", "data":"ocpp status", "newline":"\r\n", "annotate":true }
```
→ `{ "ok":true, "seq":18422, "annotation":Annotation }`
(`seq` = head at send time — the cursor to read replies from.)

### `POST /api/run`
Run an external shell command, timeline-anchored. Used to link non-serial
steps (flash scripts, CSMS triggers) into the same narrative.
```json
{ "cmd":"python3 tools/trigger_update.py --id CC01", "cwd":null,
  "timeout":120000, "label":"trigger UpdateFirmware" }
```
→ `{ "exit":0, "ms":1240, "stdout":"...", "stderr":"...", "seq":18422,
     "annotation":Annotation }`
stdout/stderr are truncated to 8 KB each in the response; the full text is
kept on disk and linked from the annotation.

### `POST /api/flash`
Flash a firmware image over a serial source logscope owns, by running the
project's flash script (`flash.script` in config.json — see
`.logscope/scripts/README.md` for the script contract). 409 if no flash script
is configured or the source is not a writable serial port.
```json
{ "file":"build/app.img", "port":null, "author":"claude" }
```
Any extra body keys are passed to the script as options (merged over the
`flash` object from config.json). Relative `file` resolves against the project
directory.
→ `{ "ok":true, "file":"…", "bytes":262144, "ms":41200, "seq":18422,
     "cursor":19011, …script-specific fields }`

### `GET /api/notes` → `{ "markdown":"...", "path":"..." , "mtime":... }`
### `PUT /api/notes` `{ "markdown":"..." }` → `{ "ok":true, "mtime":…, "bytes":… }`
### `PATCH /api/notes` `{ "append":"..." }` → `{ "ok":true, "mtime":…, "bytes":… }`

Both writes return the post-write `mtime`. A client that polls for remote edits
must record it, or it will read its own save back as someone else's change and
raise a spurious conflict.

The notes file is the durable knowledge base:
`<project>/.logscope/knowledge.md`. It survives sessions and is what removes
the need to re-prompt.

### `POST /api/mark` `{ "label":"phase-2" }` → Annotation (kind `mark`)

### `POST /api/clear` `{ "confirm":true }`
Starts a new session (new seq space, new JSONL). Knowledge.md is untouched.

## On-disk layout (in the monitored project)

```
.logscope/
  config.json          # ports, baud, parse rules, run-command aliases
  knowledge.md         # durable, human+agent curated
  sessions/
    2026-07-21T09-30-11/
      lines.jsonl
      annotations.jsonl
      runs/<id>.txt    # full stdout/stderr of /api/run
  current -> sessions/2026-07-21T09-30-11
```
