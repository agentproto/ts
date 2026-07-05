/**
 * Shared cloudflared spawn helper for the quick + named tunnel providers.
 *
 * ## Why redirect stdout/stderr to a FILE instead of a pipe
 *
 * The obvious spawn is `stdio: ["ignore", "pipe", "pipe"]` and a
 * `proc.stdout/stderr.on("data")` listener that watches for a readiness
 * marker. That works from an idle shell — but WEDGES when cloudflared is
 * spawned by a busy host process (the agentproto daemon serving MCP,
 * sessions, heartbeats, …).
 *
 * Mechanism: cloudflared emits a burst of startup log lines (the
 * connectivity precheck table, then `Registered tunnel connection`). Those
 * writes go to the OS pipe buffer (~64 KiB). If the host's Node event loop
 * doesn't drain the pipe promptly — which happens under load — the buffer
 * fills, cloudflared's next log WRITE BLOCKS, and its main path stalls
 * *before it ever opens the edge connection*. The tunnel never registers,
 * `start()` times out after 30 s, and the failure looks like a network or
 * credentials problem when it's actually stdio back-pressure.
 *
 * Redirecting stdout+stderr to a file makes those writes never block
 * (the kernel handles file writes), regardless of event-loop load — so
 * cloudflared always proceeds to the edge. Empirically verified 2026-07-05:
 * a plain-pipe spawn from the daemon wedged with zero outbound sockets;
 * the identical spawn with stdio → file registered all four edge
 * connections in <1 s.
 *
 * Bonus: because the full output lands in a file, on timeout / early exit
 * we surface the captured tail in the error — turning an opaque
 * "did not register within 30s" into an actionable message.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { closeSync, openSync, readFileSync } from "node:fs"

export interface CloudflaredSpawnOptions {
  /**
   * Absolute path of the log file that cloudflared's stdout+stderr are
   * redirected into. The caller owns its lifecycle (delete it in `stop()`).
   */
  logPath: string
  /**
   * Regex tested against the captured output. `start()` resolves as soon
   * as it matches; the resolved value is `match[0]` (the whole match) —
   * e.g. the `Registered tunnel connection` marker (named) or the
   * `*.trycloudflare.com` URL (quick).
   */
  readyRegex: RegExp
  /** Max wait before the child is killed and the promise rejects. */
  timeoutMs: number
  /**
   * Message used when the timeout fires. The captured output tail is
   * appended so the caller sees why cloudflared never became ready.
   */
  timeoutMessage: string
  /** Optional live line forwarder (the gateway's RuntimeEvents stream). */
  onLog?: (line: string) => void
  /**
   * Binary to spawn. Defaults to `"cloudflared"`. Overridable so tests can
   * drive the file-capture / readiness / timeout logic with a fake process
   * instead of a real tunnel client.
   */
  binary?: string
}

export interface CloudflaredSpawnResult {
  /** The live cloudflared child. The caller keeps it as its tunnel process. */
  proc: ChildProcess
  /** The `match[0]` that satisfied `readyRegex`. */
  match: string
  /**
   * Stop the background log-forwarder started for this child. Call it from
   * the provider's `stop()` so the interval doesn't outlive the tunnel.
   */
  stopTail: () => void
}

const POLL_INTERVAL_MS = 200

/**
 * Spawn `cloudflared <argv>` with stdout+stderr redirected to
 * `opts.logPath`, and resolve once `opts.readyRegex` matches the captured
 * output. Rejects (killing the child) on timeout, spawn error, or early
 * exit — always with the captured output tail attached.
 */
export async function spawnCloudflaredUntil(
  argv: string[],
  opts: CloudflaredSpawnOptions,
): Promise<CloudflaredSpawnResult> {
  const logFd = openSync(opts.logPath, "a")
  let proc: ChildProcess
  try {
    proc = spawn(opts.binary ?? "cloudflared", argv, {
      // stdout+stderr → file (see file header for why not a pipe).
      stdio: ["ignore", logFd, logFd],
      shell: false,
    })
  } finally {
    // The child dup'd the fd on spawn; the parent's copy is redundant.
    closeSync(logFd)
  }

  const readAll = (): string => {
    try {
      return readFileSync(opts.logPath, "utf8")
    } catch {
      return ""
    }
  }
  const tail = (n: number): string => {
    const lines = readAll().split(/\r?\n/).filter(l => l.length > 0)
    return lines.slice(-n).join("\n") || "(no cloudflared output captured)"
  }

  let settled = false
  let forwardedLen = 0

  return await new Promise<CloudflaredSpawnResult>((resolve, reject) => {
    // One interval does double duty: forward newly-flushed complete lines
    // to onLog, and (until settled) test the readiness marker. After the
    // marker matches, it keeps running as a plain forwarder so ongoing
    // tunnel chatter still reaches RuntimeEvents; `stopTail` clears it.
    const poll = setInterval(() => {
      const text = readAll()
      if (opts.onLog) {
        const lastNl = text.lastIndexOf("\n")
        if (lastNl + 1 > forwardedLen) {
          const chunk = text.slice(forwardedLen, lastNl + 1)
          for (const line of chunk.split(/\r?\n/)) {
            if (line.length > 0) opts.onLog(`[cloudflared] ${line}`)
          }
          forwardedLen = lastNl + 1
        }
      }
      if (settled) return
      const m = text.match(opts.readyRegex)
      if (m) {
        settled = true
        clearTimeout(timer)
        resolve({ proc, match: m[0], stopTail: () => clearInterval(poll) })
      }
    }, POLL_INTERVAL_MS)
    if (poll.unref) poll.unref()

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(poll)
      reject(err)
    }

    const timer = setTimeout(() => {
      if (settled) return
      try {
        proc.kill("SIGTERM")
      } catch {
        /* noop */
      }
      fail(new Error(`${opts.timeoutMessage}\ncloudflared output (tail):\n${tail(20)}`))
    }, opts.timeoutMs)

    proc.once("error", err => fail(err))
    proc.once("exit", (code, signal) =>
      fail(
        new Error(
          `cloudflared exited before it was ready ` +
            `(code=${code}, signal=${signal}).\n` +
            `cloudflared output (tail):\n${tail(20)}`,
        ),
      ),
    )
  })
}
