import { test } from "node:test";
import assert from "node:assert/strict";
import { crc16, buildBlock, sendXmodem, STX, EOT, ACK, NAK, CAN, SUB, CRC_C } from "../src/xmodem.js";

test("crc16 matches the CRC-16/XMODEM check vector", () => {
	assert.equal(crc16(Buffer.from("123456789")), 0x31c3);
});

test("buildBlock frames, pads with SUB, and appends CRC", () => {
	const data = Buffer.from("hello");
	const f = buildBlock(1, data, 1024);
	assert.equal(f.length, 3 + 1024 + 2);
	assert.equal(f[0], STX);
	assert.equal(f[1], 1);
	assert.equal(f[2], 254); // 255 - blk
	assert.deepEqual(f.subarray(3, 8), data);
	assert.equal(f[8], SUB); // padding starts
	const payload = f.subarray(3, 3 + 1024);
	const crc = crc16(payload);
	assert.equal(f[3 + 1024], (crc >> 8) & 0xff);
	assert.equal(f[3 + 1024 + 1], crc & 0xff);
});

test("block number wraps at 255", () => {
	const f = buildBlock(256, Buffer.alloc(1), 1024);
	assert.equal(f[1], 0);
	assert.equal(f[2], 255);
});

/**
 * A scripted XMODEM receiver. `respond(frame)` returns the bytes to queue for
 * the sender's next rawRead calls.
 */
class FakePort {
	constructor(respond) {
		this.rx = [];
		this.frames = [];
		this.respond = respond;
	}
	write(buf) {
		const b = Buffer.from(buf);
		this.frames.push(b);
		const r = this.respond(b);
		if (r) this.rx.push(...r);
	}
	rawFlush() {
		this.rx.length = 0;
	}
	async rawRead(n, timeout) {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			if (this.rx.length) return Buffer.from(this.rx.splice(0, n));
			await new Promise((r) => setTimeout(r, 2));
		}
		return null;
	}
	prime(...bytes) {
		this.rx.push(...bytes);
	}
}

test("happy path: C → blocks ACKed → EOT ACKed", async () => {
	const port = new FakePort((frame) => {
		if (frame.length === 1 && frame[0] === EOT) return [ACK];
		if (frame[0] === STX) return [ACK];
		return null;
	});
	port.prime(CRC_C);
	const data = Buffer.alloc(2500, 0xab); // 3 blocks
	const progress = [];
	const r = await sendXmodem(port, data, {
		startTimeout: 500,
		ackTimeout: 200,
		onProgress: (p) => progress.push(p.block),
	});
	assert.equal(r.ok, true);
	assert.equal(r.blocks, 3);
	assert.equal(r.retries, 0);
	assert.deepEqual(progress, [1, 2, 3]);
	// data frames + EOT
	const dataFrames = port.frames.filter((f) => f[0] === STX);
	assert.equal(dataFrames.length, 3);
	assert.deepEqual([...dataFrames.map((f) => f[1])], [1, 2, 3]);
});

test("NAK causes a resend and is counted", async () => {
	let nakked = false;
	const port = new FakePort((frame) => {
		if (frame.length === 1 && frame[0] === EOT) return [ACK];
		if (frame[0] === STX) {
			if (frame[1] === 2 && !nakked) {
				nakked = true;
				return [NAK];
			}
			return [ACK];
		}
		return null;
	});
	port.prime(CRC_C);
	const r = await sendXmodem(port, Buffer.alloc(2048), { startTimeout: 500, ackTimeout: 200 });
	assert.equal(r.ok, true);
	assert.equal(r.retries, 1);
	const block2Sends = port.frames.filter((f) => f[0] === STX && f[1] === 2);
	assert.equal(block2Sends.length, 2);
});

test("receiver CAN mid-transfer aborts with block count", async () => {
	const port = new FakePort((frame) => {
		if (frame[0] === STX) return frame[1] === 2 ? [CAN] : [ACK];
		return null;
	});
	port.prime(CRC_C);
	const r = await sendXmodem(port, Buffer.alloc(3000), { startTimeout: 500, ackTimeout: 200 });
	assert.equal(r.ok, false);
	assert.equal(r.blocks, 1);
	assert.match(r.error, /cancelled at block 2/);
});

test("no start signal times out", async () => {
	const port = new FakePort(() => null);
	const r = await sendXmodem(port, Buffer.alloc(10), { startTimeout: 100 });
	assert.equal(r.ok, false);
	assert.match(r.error, /timed out waiting for 'C'/);
});

test("silence after every block exhausts retries", async () => {
	const port = new FakePort(() => null);
	port.prime(CRC_C);
	const r = await sendXmodem(port, Buffer.alloc(10), {
		startTimeout: 200,
		ackTimeout: 10,
		retries: 2,
	});
	assert.equal(r.ok, false);
	assert.match(r.error, /no ACK for block 1 after 2 retries/);
});

test("all blocks ACKed but EOT lost is reported precisely", async () => {
	const port = new FakePort((frame) => {
		if (frame[0] === STX) return [ACK];
		return null; // never ACK the EOT
	});
	port.prime(CRC_C);
	const r = await sendXmodem(port, Buffer.alloc(10), {
		startTimeout: 200,
		ackTimeout: 100,
		eotTimeout: 50,
	});
	assert.equal(r.ok, false);
	assert.equal(r.blocks, 1);
	assert.match(r.error, /EOT was never acknowledged/);
});
