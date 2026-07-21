import { test } from "node:test";
import assert from "node:assert/strict";
import { makeParser, parseLine, compileRules, stripAnsi, shapeKey, PRESET_ORDER } from "../src/parse.js";

const all = makeParser({});

test("zephyr preset", () => {
	const l = all("[00:04:12.881,123] <inf> ocpp: download complete 262144B");
	assert.equal(l.lvl, "inf");
	assert.equal(l.tag, "ocpp");
	assert.equal(l.msg, "download complete 262144B");
	assert.equal(l.dev_ts, "00:04:12.881,123");
});

test("uptime-level preset with null module lifts a leading tag", () => {
	const a = all('490941:INFO:null: ocpp rx [3,"id",{}]');
	assert.equal(a.lvl, "inf");
	assert.equal(a.tag, null); // "ocpp rx" is not an identifier: stays in msg
	assert.equal(a.msg, 'ocpp rx [3,"id",{}]');
	assert.equal(a.dev_ts, "490941");

	const b = all("492965:INFO:null: charger: IDLE -> UPDATING");
	assert.equal(b.tag, "charger");
	assert.equal(b.msg, "IDLE -> UPDATING");

	const c = all("493401:WARN:null: ocpp: rebooting");
	assert.equal(c.lvl, "wrn");
	assert.equal(c.tag, "ocpp");
});

test("uptime-level with a real module name", () => {
	const l = all("2098826:ERROR:fwup: staged image bad");
	assert.equal(l.lvl, "err");
	assert.equal(l.tag, "fwup");
	assert.equal(l.msg, "staged image bad");
});

test("level-only preset", () => {
	const l = all("<err> nbiot: socket 8 closed");
	assert.equal(l.lvl, "err");
	assert.equal(l.tag, "nbiot");
});

test("zephyr-bare lifts bracketed tag and promotes faults", () => {
	const a = all("[17:53:50.804] [NBIOT] TX AT+CEREG?");
	assert.equal(a.dev_ts, "17:53:50.804");
	assert.equal(a.tag, "NBIOT");
	assert.equal(a.msg, "TX AT+CEREG?");

	const b = all("[17:53:50.804] HARD FAULT at 0x0800");
	assert.equal(b.lvl, "err");
});

test("bracket-tag preset enriches without claiming", () => {
	const l = all("[NBIOT] PANIC in modem task");
	assert.equal(l.tag, "NBIOT");
	assert.equal(l.lvl, "err"); // faults still ran after bracket-tag
});

test("faults preset promotes unlevelled crash text", () => {
	assert.equal(all("ASSERTION FAIL @ main.c:42").lvl, "err");
	assert.equal(all("*** Booting Zephyr OS build v3.7.2 ***").lvl, null); // banner is not a fault
});

test("unmatched lines pass through raw, never dropped", () => {
	const l = all("\\_   ___ \\|  |__ ascii art");
	assert.equal(l.lvl, null);
	assert.equal(l.tag, null);
	assert.equal(l.msg, l.raw);
});

test("preset selection limits what parses", () => {
	const p = makeParser({ presets: ["uptime-level"] });
	assert.equal(p("100:INFO:mod: hi").tag, "mod");
	const z = p("[00:00:01.000] <inf> zeph: nope");
	assert.equal(z.lvl, null);
	assert.equal(z.msg, z.raw);
});

test("empty preset list is raw passthrough", () => {
	const p = makeParser({ presets: [] });
	const l = p("[00:04:12.881] <inf> ocpp: x");
	assert.equal(l.lvl, null);
	assert.equal(l.msg, l.raw);
});

test("unknown preset throws at build time", () => {
	assert.throws(() => makeParser({ presets: ["zehpyr"] }), /unknown parser preset "zehpyr"/);
});

test("custom rules run before presets and support literals", () => {
	const p = makeParser({
		presets: PRESET_ORDER,
		rules: compileRules([{ re: "^APP\\|(\\w+)\\|(.*)$", lvl: "=wrn", tag: 1, msg: 2 }]),
	});
	const l = p("APP|net|link down");
	assert.equal(l.lvl, "wrn");
	assert.equal(l.tag, "net");
	assert.equal(l.msg, "link down");
	// non-matching lines still reach the presets
	assert.equal(p("<inf> a: b").tag, "a");
});

test("control bytes and ANSI are stripped", () => {
	assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red");
	const l = all("\x1b[2J\x00<inf> a: b\x07");
	assert.equal(l.tag, "a");
	assert.equal(l.msg, "b");
});

test("legacy parseLine still works", () => {
	assert.equal(parseLine("[00:04:12.881] <inf> ocpp: x").tag, "ocpp");
});

test("shapeKey collapses varying digits/hex/strings", () => {
	const a = shapeKey({ msg: 'retry 3 at 0xDEAD for "dev-1"' });
	const b = shapeKey({ msg: 'retry 17 at 0xBEEF for "dev-2"' });
	assert.equal(a, b);
});
