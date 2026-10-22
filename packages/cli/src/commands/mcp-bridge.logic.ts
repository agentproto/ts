/**
 * Pure logic for the mcp-bridge's origin auto-stamp. The bridge is spawned by
 * its stdio host (Codex, Cursor, Claude Desktop, …) and inherits nothing that
 * identifies a conversation — but the host DOES announce itself in the MCP
 * `initialize` handshake (`clientInfo.name`). The bridge reads that name and
 * stamps it as the `origin` of any spawn it forwards, so a bridge-routed host
 * gets a source node in the sessions tree with zero cooperation.
 *
 * This is the honest ceiling: it identifies the HOST ("codex"), never a
 * specific conversation — a stateless shared endpoint has no per-conversation
 * signal (see #575). Descriptor-only; never overrides an origin the caller set
 * explicitly, and only touches session-creating tools.
 */

/** Tools that create a session and accept an `origin` (see agent-tools.ts). */
export const ORIGIN_STAMP_TOOLS: ReadonlySet<string> = new Set(["agent_start"])

/**
 * Return `params` with `arguments.origin` set to `hostName` when: a host name
 * is known, the tool is one that records an origin, and the caller did not
 * already provide one. Otherwise returns `params` unchanged (same reference).
 * Generic over the params shape so the forwarded call keeps its exact type.
 */
export function stampOrigin<
  T extends { name: string; arguments?: Record<string, unknown> },
>(params: T, hostName: string | undefined): T & { arguments?: Record<string, unknown> } {
  if (!hostName) return params
  if (!ORIGIN_STAMP_TOOLS.has(params.name)) return params
  const args = params.arguments
  if (args && typeof args.origin === "string" && args.origin.length > 0) return params
  return { ...params, arguments: { ...(args ?? {}), origin: hostName } }
}

/**
 * The stdio peer (Codex, Cursor, Claude Desktop, an agent CLI, …) owns the
 * bridge: it keeps the bridge's stdin open for as long as it wants the bridge
 * around. When it exits — gracefully or killed — the write end of that pipe
 * closes and stdin reaches EOF. That EOF is the portable "my peer is gone"
 * signal on every platform (no pids, no signals), so the bridge must exit on
 * it instead of parking forever behind an open HTTP client transport.
 *
 * Also fires when stdin is already at EOF by the time we attach, and when the
 * stream is destroyed (`close`) without an `end`.
 */
export function exitOnStdinClose(
  stdin: {
    on: (event: "end" | "close", listener: () => void) => unknown
    off: (event: "end" | "close", listener: () => void) => unknown
    readableEnded?: boolean
    destroyed?: boolean
  },
  exit: (code: number) => void,
): () => void {
  let fired = false
  const fire = (): void => {
    if (fired) return
    fired = true
    exit(0)
  }
  stdin.on("end", fire)
  stdin.on("close", fire)
  if (stdin.readableEnded === true || stdin.destroyed === true) fire()
  return () => {
    stdin.off("end", fire)
    stdin.off("close", fire)
  }
}

/**
 * Belt-and-braces for hosts that hand the bridge an inherited terminal
 * instead of a private pipe: in that case the parent can die without closing
 * the bridge's stdin, so EOF never arrives. On POSIX the kernel reparents the
 * orphan and `process.ppid` changes (to 1, or to a subreaper). Poll for that
 * and exit. Windows never reparents — `process.ppid` would stay stale — so the
 * watchdog is a no-op there; the stdin-EOF check above still covers it.
 */
export function watchParentExit(
  exit: (code: number) => void,
  opts: {
    platform?: NodeJS.Platform
    initialPpid?: number
    intervalMs?: number
  } = {},
): () => void {
  if ((opts.platform ?? process.platform) === "win32") return () => {}
  const initialPpid = opts.initialPpid ?? process.ppid
  const timer = setInterval(() => {
    if (process.ppid !== initialPpid) {
      clearInterval(timer)
      exit(0)
    }
  }, opts.intervalMs ?? 2_000)
  timer.unref()
  return () => clearInterval(timer)
}
