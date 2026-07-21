import { test } from "node:test";
import assert from "node:assert/strict";
import { LineSplitter } from "../src/linesplit.js";

function run(chunks) {
	const s = new LineSplitter();
	const out = [];
	for (const c of chunks) out.push(...s.push(c));
	const rest = s.flush();
	if (rest != null) out.push(rest);
	return out;
}

test("LF", () => {
	assert.deepEqual(run(["A\nB\n"]), ["A", "B"]);
});

test("CRLF in one chunk", () => {
	assert.deepEqual(run(["A\r\nB\r\n"]), ["A", "B"]);
});

test("CRCRLF (driver double-maps NL) does not manufacture blank lines", () => {
	assert.deepEqual(run(["A\r\r\nB\r\r\n"]), ["A", "B"]);
});

test("CRLF straddling a chunk boundary", () => {
	assert.deepEqual(run(["A\r", "\nB\r", "\nC\r\n"]), ["A", "B", "C"]);
});

test("intentional blank line survives", () => {
	assert.deepEqual(run(["A\r\n\r\nB\r\n"]), ["A", "", "B"]);
});

test("bare CR acts as a terminator (progress lines)", () => {
	assert.deepEqual(run(["A\rB\rC"]), ["A", "B", "C"]);
});

test("held CR then more data on a later push", () => {
	const s = new LineSplitter();
	assert.deepEqual(s.push("A\r"), []); // held — could be half a CRLF
	assert.deepEqual(s.push("B"), ["A"]); // next byte proves it was bare CR
	assert.equal(s.pending, "B");
});

test("flush strips a trailing held CR", () => {
	const s = new LineSplitter();
	s.push("prompt> \r");
	assert.equal(s.flush(), "prompt> ");
	assert.equal(s.flush(), null);
});

test("flush on empty returns null", () => {
	assert.equal(new LineSplitter().flush(), null);
});

test("split terminator never reorders or drops across many small chunks", () => {
	const text = "one\r\ntwo\nthree\rfour\r\r\nfive\n";
	for (let size = 1; size <= 5; size++) {
		const chunks = [];
		for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
		assert.deepEqual(run(chunks), ["one", "two", "three", "four", "five"], `chunk size ${size}`);
	}
});
