/**
 * Removes terminal *queries* (requests that expect a reply on the child's
 * stdin) from a recorded byte stream.
 *
 * The session byte buffer is replayed to every terminal that attaches
 * late. A terminal answers each query it sees, so replaying a query that
 * the child sent at startup makes the attaching terminal answer seconds
 * after the fact: the child has already given up waiting, and the late
 * reply lands in its input as stray characters. Queries are therefore
 * dropped from the replay; everything that only draws (colours, cursor
 * moves, titles, image transmissions) is kept byte for byte.
 *
 * Covered queries:
 *   - device attributes `CSI c`, `CSI > c`, `CSI = c`
 *   - terminal identity `CSI > q` (XTVERSION)
 *   - keyboard protocol flags `CSI ? u`
 *   - status reports `CSI 5 n`, `CSI 6 n`, `CSI ? Ps n`
 *   - mode state `CSI ? Ps $ p`, `CSI Ps $ p`
 *   - window and cell size reports `CSI Ps t` for Ps in 11, 13-16, 18-21
 *   - string requests `DCS + q …` and `DCS $ q …`
 *   - colour requests `OSC Ps ; ? (BEL | ST)`
 *   - graphics support probes `APC G … a=q … ST`
 */

/** One pattern per query family, written against a latin1 string so every
 *  byte maps to exactly one character and nothing else is altered.
 *  `CSI 0 n` is not listed on purpose: it is the "terminal ready" reply to a
 *  status request, not a request. */
const QUERY_PATTERNS = [
  "\\x1b\\[[>=]?0?c", // device attributes
  "\\x1b\\[>0?q", // terminal identity
  "\\x1b\\[\\?u", // keyboard protocol flags
  "\\x1b\\[(?:[56]|\\?[0-9]+)n", // status reports
  "\\x1b\\[\\??[0-9]+\\$p", // mode state
  "\\x1b\\[(?:11|1[3-6]|1[89]|2[01])(?:;[0-9]+)*t", // window and cell size
  "\\x1bP[+$]q[^\\x1b]*\\x1b\\\\", // string requests
  "\\x1b\\][0-9]+(?:;[0-9]+)*;\\?(?:\\x07|\\x1b\\\\)", // colour requests
  "\\x1b_G(?:[a-zA-Z]=[^,;\\x1b]*,)*a=q(?:,[a-zA-Z]=[^,;\\x1b]*)*(?:;[^\\x1b]*)?\\x1b\\\\", // graphics probe
]

/** The `g` flag makes this regex stateful: use it only with
 *  `String.prototype.replace`, which resets `lastIndex` when it finishes. */
const QUERY_SEQUENCES = new RegExp(QUERY_PATTERNS.join("|"), "g")

/** Same families, anchored: matches one whole escape sequence. */
const WHOLE_QUERY = new RegExp(`^(?:${QUERY_PATTERNS.join("|")})$`)

/** True when `sequence` (one complete escape sequence, latin1) is a
 *  terminal query, i.e. a request whose answer goes to the child's stdin. */
export function isTerminalQuery(sequence: string): boolean {
  return WHOLE_QUERY.test(sequence)
}

/** Returns `bytes` without terminal queries. The input is not modified. */
export function stripTerminalQueries(bytes: Buffer): Buffer {
  const text = bytes.toString("latin1")
  // Cheap exit: every query starts with ESC.
  if (!text.includes("\x1b")) return bytes
  const stripped = text.replace(QUERY_SEQUENCES, "")
  return stripped.length === text.length ? bytes : Buffer.from(stripped, "latin1")
}
