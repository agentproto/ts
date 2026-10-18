/**
 * Daemon log timestamps — every line the serve process writes to
 * `~/.agentproto/daemon.log` is prefixed with the write moment in ISO-8601
 * (`2026-10-18T19:41:02.123Z`), so a log tail can be correlated across
 * restarts. The OS still does the redirection (launchd's
 * StandardOut/ErrorPath, the Windows launcher's `>> daemon.log 2>&1`), so
 * the seam is the process's own stdout/stderr JS writers: a line-aware
 * wrapper prepends the timestamp at every line start and leaves the
 * original bytes — colors, multiline banners, trailing-newline behavior —
 * byte-identical otherwise. Only installed when the stream is redirected
 * (not a TTY): interactive `serve` keeps its unprefixed TUI.
 */

/** ISO-8601 wall clock at the moment of the write. Injectable for tests. */
const nowIso = (now: () => Date = () => new Date()): string => now().toISOString()

/**
 * Wrap one stream's `write` so every LOGICAL LINE starts with the
 * timestamp + a single space. A chunk that doesn't end on a newline is a
 * partial line: it is passed through untouched, and the NEXT chunk
 * continues that line (no mid-line prefix). Line endings (`\n`) inside a
 * chunk each start a new timestamped line, all stamped with the same
 * write moment. `unref`-style plumbing (encoding arg, options object,
 * callback) is forwarded unchanged; `end()`/`destroy()` are left alone.
 */
export function timestampedWrite(
  stream: {
    write(...args: unknown[]): boolean
  },
  opts: { now?: () => Date } = {},
): () => void {
  const original = stream.write
  const out = original.bind(stream)
  // Line-start tracker: true right after a newline (or at process start).
  let lineStart = true
  stream.write = (...args: unknown[]): boolean => {
    const raw = args[0]
    if (typeof raw === "string" && raw.length > 0) {
      const prefix = `${nowIso(opts.now)} `
      // Stamp the leading partial line when one is open, then every full
      // line inside this chunk. A chunk that ends ON a newline leaves
      // `lineStart` true (the next chunk begins a fresh, stamped line); a
      // chunk ending mid-line passes its suffix through untouched (the
      // next chunk continues THAT line — no mid-line prefix).
      let stamped: string
      if (!lineStart) {
        const firstNl = raw.indexOf("\n")
        if (firstNl === -1) {
          stamped = raw
        } else {
          stamped = raw.slice(0, firstNl + 1) + prefixLines(raw.slice(firstNl + 1), prefix)
        }
      } else {
        stamped = prefixLines(raw, prefix)
      }
      lineStart = raw.endsWith("\n")
      return out(stamped, ...args.slice(1))
    }
    // Buffers, Uint8Arrays and empty/undefined writes pass through: every
    // log writer here is textual; a non-string write is never a "line".
    lineStart = false
    return out(...args)
  }

  /** Prefix every logical line of `s` with `prefix`; a trailing newline's
   *  (empty) imaginary segment gets none. */
  function prefixLines(s: string, prefix: string): string {
    let parts = s.split("\n")
    let suffix = ""
    if (s.endsWith("\n")) {
      parts = parts.slice(0, -1)
      suffix = "\n"
    }
    return parts.map(seg => prefix + seg).join("\n") + suffix
  }

  return () => {
    stream.write = original
    ;(stream as typeof stream & { __agentprotoTimestamped?: boolean }).__agentprotoTimestamped = false
  }
}

/**
 * Install the timestamped writers on `process.stdout`+`process.stderr`
 * when the process's output is redirected (not a TTY on either side).
 * Idempotent — the two install calls that runServe can trigger under a
 * Ctrl-C race never double-prefix. Returns the unwinders (for tests).
 */
export function installDaemonLogTimestamps(
  streams: { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream } = process,
  opts: { now?: () => Date } = {},
): Array<() => void> {
  const undid: Array<() => void> = []
  for (const stream of [streams.stdout, streams.stderr]) {
    if (stream.isTTY) continue
    // Only wrap OUR writer, not one a previous install (or test) already
    // wrapped — `__agentprotoTimestamped` marks the wrapper.
    const s = stream as unknown as { write: (...a: unknown[]) => boolean; __agentprotoTimestamped?: boolean }
    if (s.__agentprotoTimestamped) continue
    undid.push(timestampedWrite(stream, opts))
    s.__agentprotoTimestamped = true
  }
  return undid
}

