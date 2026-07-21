// XMODEM-1K sender.
//
// Ported from what tools/fw_download.py drives via pyserial, so that a flash
// can run through the port logscope already owns instead of handing the tty to
// a separate process. That matters for more than tidiness: driving it here puts
// the whole bootloader dialogue and the transfer's progress into the same
// timestamped timeline as everything else.
//
// Wire format (1K variant, CRC mode):
//   STX | blk | 255-blk | data[1024] | crc_hi | crc_lo
// The receiver opens with 'C' to request CRC framing, ACKs each good block, and
// NAKs one it wants resent. EOT ends the stream.

export const SOH = 0x01;
export const STX = 0x02;
export const EOT = 0x04;
export const ACK = 0x06;
export const NAK = 0x15;
export const CAN = 0x18;
export const SUB = 0x1a; // pad byte for a short final block
export const CRC_C = 0x43; // 'C'

/** CRC-16/XMODEM: poly 0x1021, init 0x0000, no reflection, no final xor. */
export function crc16(buf) {
	let crc = 0;
	for (const b of buf) {
		crc ^= b << 8;
		for (let i = 0; i < 8; i++) {
			crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
		}
	}
	return crc & 0xffff;
}

/**
 * Frame one block.
 *
 * `size` is fixed by the caller rather than chosen from the payload length: the
 * reference implementation (python `xmodem` in xmodem1k mode) pads even the
 * final short block out to 1024 and keeps using STX. Auto-downgrading a short
 * tail to a 128-byte SOH block is legal XMODEM but is NOT what the bootloader
 * on the other end has been proven against, so don't get clever.
 */
export function buildBlock(blockNo, data, size = 1024) {
	const use1k = size > 128;
	const payload = Buffer.alloc(size, SUB);
	data.copy(payload);
	const crc = crc16(payload);
	return Buffer.concat([
		Buffer.from([use1k ? STX : SOH, blockNo & 0xff, 255 - (blockNo & 0xff)]),
		payload,
		Buffer.from([(crc >> 8) & 0xff, crc & 0xff]),
	]);
}

/**
 * Send `data` over an acquired raw serial port.
 *
 * @param {object}   port      SerialPort in raw mode
 * @param {Buffer}   data      file contents
 * @param {object}   opts
 * @param {number}   opts.startTimeout  ms to wait for the receiver's 'C'
 * @param {number}   opts.ackTimeout    ms to wait for each ACK
 * @param {number}   opts.retries       per-block resend attempts
 * @param {function} opts.onProgress    ({sent,total,block,retries}) => void
 * @param {function} opts.onNote        (string) => void, for the log
 * @returns {Promise<{ok:boolean, blocks:number, retries:number, error?:string}>}
 */
export async function sendXmodem(port, data, opts = {}) {
	const {
		startTimeout = 15000,
		ackTimeout = 10000,
		retries = 16,
		blockSize = 1024,
		onProgress = () => {},
		onNote = () => {},
	} = opts;

	// 1. Wait for the receiver to announce CRC mode.
	onNote("waiting for XMODEM-CRC start signal ('C')");
	const started = Date.now();
	let sawC = false;
	while (Date.now() - started < startTimeout) {
		const b = await port.rawRead(1, 500);
		if (!b) continue;
		if (b[0] === CRC_C) {
			sawC = true;
			break;
		}
		if (b[0] === CAN) return { ok: false, blocks: 0, retries: 0, error: "receiver cancelled" };
	}
	if (!sawC) {
		return { ok: false, blocks: 0, retries: 0, error: "timed out waiting for 'C'" };
	}

	// The receiver keeps emitting 'C' until the first block lands; drop the
	// extras so they aren't mistaken for an ACK later.
	await new Promise((r) => setTimeout(r, 200));
	port.rawFlush();

	// 2. Stream the blocks.
	const total = data.length;
	const nBlocks = Math.ceil(total / blockSize);
	let retryTotal = 0;

	for (let i = 0; i < nBlocks; i++) {
		const chunk = data.subarray(i * blockSize, Math.min((i + 1) * blockSize, total));
		const frame = buildBlock(i + 1, chunk, blockSize);

		let acked = false;
		for (let attempt = 0; attempt <= retries; attempt++) {
			if (attempt > 0) retryTotal++;
			port.write(frame);
			const r = await port.rawRead(1, ackTimeout);
			if (!r) continue; // silence — resend
			if (r[0] === ACK) {
				acked = true;
				break;
			}
			if (r[0] === CAN) {
				return {
					ok: false,
					blocks: i,
					retries: retryTotal,
					error: `receiver cancelled at block ${i + 1}`,
				};
			}
			// NAK or noise: resend.
		}
		if (!acked) {
			return {
				ok: false,
				blocks: i,
				retries: retryTotal,
				error: `no ACK for block ${i + 1} after ${retries} retries`,
			};
		}
		onProgress({
			sent: Math.min((i + 1) * blockSize, total),
			total,
			block: i + 1,
			blocks: nBlocks,
			retries: retryTotal,
		});
	}

	// 3. EOT, retried — a lost EOT looks identical to a hung transfer.
	for (let attempt = 0; attempt < 5; attempt++) {
		port.write(Buffer.from([EOT]));
		const r = await port.rawRead(1, 3000);
		if (r && r[0] === ACK) {
			return { ok: true, blocks: nBlocks, retries: retryTotal };
		}
	}
	// Every block was acknowledged, so the image is on the device; only the
	// end-of-transfer handshake is unconfirmed. Say so precisely.
	return {
		ok: false,
		blocks: nBlocks,
		retries: retryTotal,
		error: "all blocks ACKed but EOT was never acknowledged",
	};
}
