// Line-ending normalisation, shared by the serial reader and the file tail.
//
// Devices are inconsistent (\n, \r\n, bare \r progress lines), and two traps
// manufacture a phantom blank line between every real one if handled naively:
//
//  * `\r\r\n` — a firmware that writes "\r\n" through a driver that also maps
//    NL→CRNL. Splitting on \r *or* \n sees two terminators, so the run of CRs
//    before a LF has to be part of the same terminator.
//  * a CRLF straddling a read boundary — the \r ends this chunk and the \n
//    starts the next. So trailing CRs are held, not split on, until the byte
//    that follows them has been seen.

export class LineSplitter {
	constructor() {
		this.pending = "";
	}

	/** Feed a chunk of text; returns the complete lines it terminated. */
	push(text) {
		this.pending += text;
		const held = /\r+$/.exec(this.pending);
		const body = held ? this.pending.slice(0, -held[0].length) : this.pending;
		const parts = body.split(/\r*\n|\r/);
		this.pending = parts.pop() + (held ? held[0] : "");
		return parts;
	}

	/**
	 * Give up on the remainder ever being terminated (prompt-style partial
	 * lines). A held CR that never got its LF was a terminator after all, so it
	 * is stripped rather than returned. Returns null when there is nothing.
	 */
	flush() {
		if (!this.pending.length) return null;
		const p = this.pending.replace(/\r+$/, "");
		this.pending = "";
		return p;
	}
}
