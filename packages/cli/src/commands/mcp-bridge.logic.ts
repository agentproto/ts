/**
 * Pure logic for the mcp-bridge's origin auto-stamp. The bridge is spawned by
 * its stdio host (Codex, Cursor, Claude Desktop, …) and inherits nothing that
 * identifies a conversation — but the host DOES announce itself in the MCP
 * `initialize` handshake (`clientInfo.name`). The bridge reads that name and
 * stamps it as the `origin` of any spawn it forwards, so a bridge-routed host
 * gets a source node in the sessions tree with zero cooperation.
 *
 * The handshake identifies only the HOST. Conversation identity, when the
 * host supplies it, must come from EACH call's metadata: a stdio process may
 * serve several chats. Never cache a last-seen thread or infer one from a
 * bridge process's environment.
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

/** Codex Desktop's app-tools plugin reads these same per-call metadata keys.
 * They are host context, never model-facing tool arguments. No metadata means
 * no identity; in particular, clientInfo.name alone is insufficient. */
export function bridgeCallerUrl(baseUrl: string, meta?: Record<string, unknown>, hostName?: string): string {
  const url = new URL(baseUrl)
  // Preserve daemon-spawned self-mounts and explicit bridge configuration.
  // Approval cards deliberately forbid caller identities on their surface.
  if (url.searchParams.has("callerSessionId") || url.searchParams.get("surface") === "approval-cards") return baseUrl
  if (!meta) return baseUrl
  // Generic threadId/thread.id fields only identify a Codex chat when the
  // handshake identifies Codex. The namespaced Codex metadata is sufficient
  // on its own (some host versions use a generic clientInfo name).
  if (!hostName?.toLowerCase().includes("codex") &&
      !("x-codex-turn-metadata" in meta) && !("openai/threadId" in meta) && !("openai/thread_id" in meta)) return baseUrl
  let thread: unknown
  for (const key of ["openai/threadId", "openai/thread_id", "codexThreadId", "codex_thread_id", "threadId", "thread_id"]) {
    if (typeof meta[key] === "string" && meta[key].trim()) {
      thread = meta[key]
      break
    }
  }
  if (thread === undefined) {
    let turn = meta["x-codex-turn-metadata"]
    if (typeof turn === "string") {
      try { turn = JSON.parse(turn) } catch { return baseUrl }
    }
    if (turn && typeof turn === "object" && "thread_id" in turn) thread = turn.thread_id
  }
  if (thread === undefined && meta.thread && typeof meta.thread === "object" && "id" in meta.thread) thread = meta.thread.id
  // Match the daemon's external-id validation, leaving room for the namespace.
  if (typeof thread !== "string" || !/^[A-Za-z0-9._:-]{1,122}$/.test(thread)) return baseUrl
  url.searchParams.set("callerSessionId", `codex:${thread}`)
  url.searchParams.set("host", "codex")
  return url.toString()
}
