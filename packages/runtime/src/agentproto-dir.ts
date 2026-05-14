/**
 * `.agentproto/` config dir — runtime-managed state at the root of
 * every workspace. Mirrors the `.git/` model: user-content stays at
 * the workspace root (HEARTBEAT.md, conversations/, .agents/) while
 * everything the runtime owns lives in `<workspace>/.agentproto/`.
 *
 * What goes here today:
 *   - `runtime.json` — boot-time snapshot of the live config (PID,
 *     port, resolved workspace, MCP server name, startedAt). Useful
 *     for `cat .agentproto/runtime.json` diagnostics + future tooling
 *     that wants to discover a running gateway from disk.
 *
 * What does NOT go here:
 *   - HEARTBEAT.md — user-edited content
 *   - conversations/ — user-readable chat history
 *   - .agents/ — user-authored manifests
 *
 * The `.agentproto/` dir is safe to gitignore. The `runtime.json`
 * file contains a per-boot bearer token used to gate mutating HTTP
 * routes (POST /sessions/*, WS /sessions/:id/pty). The token lives
 * in RAM + on disk only — never logged. File mode 0600 below; only
 * processes running as the workspace user (and the daemon itself)
 * can read it. A browser-loaded localhost page CAN'T read this file,
 * which is what defends against the localhost-DNS-rebinding drive-by
 * spawn vector.
 */

import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

export interface RuntimeMeta {
  /** Absolute path to the workspace root the gateway is bound to. */
  workspace: string
  /** HTTP listener port. */
  port: number
  /** HTTP bind address (loopback or `0.0.0.0`). */
  bind: string
  /** Process id of the running gateway. */
  pid: number
  /** Wall-clock ISO timestamp at boot. */
  startedAt: string
  /** MCP server name advertised in the initialize handshake. */
  name: string
  /** AIP doctype names + extensions registered as MCP CRUD tools. */
  registered: readonly string[]
  /**
   * Per-boot bearer token. Required on mutating routes (POST
   * /sessions/*, POST /sessions/:id/kill, DELETE /sessions/:id, and
   * WS upgrade to /sessions/:id/pty). Random uuid generated at boot
   * by createGateway; regenerated each restart.
   */
  token: string
}

/**
 * Create `<workspace>/.agentproto/` (idempotent) and write the
 * `runtime.json` snapshot. Errors are logged but non-fatal — losing
 * the meta file shouldn't crash the gateway, the runtime is still
 * fully functional without it.
 */
export async function writeRuntimeMeta(
  workspace: string,
  meta: RuntimeMeta,
): Promise<void> {
  const dir = join(workspace, ".agentproto")
  try {
    await mkdir(dir, { recursive: true })
    // mode 0600 so other local users can't read the bearer token.
    await writeFile(
      join(dir, "runtime.json"),
      JSON.stringify(meta, null, 2) + "\n",
      { encoding: "utf8", mode: 0o600 },
    )
  } catch (err) {
    console.error("[runtime] failed to write .agentproto/runtime.json:", err)
  }
}

/**
 * Delete `<workspace>/.agentproto/runtime.json`. Best-effort — called
 * from the daemon's graceful shutdown path so a CLI looking for the
 * live daemon doesn't pick up a stale token after this process exits.
 * Missing file is a no-op (the daemon may never have written one).
 */
export async function unlinkRuntimeMeta(workspace: string): Promise<void> {
  try {
    await unlink(join(workspace, ".agentproto", "runtime.json"))
  } catch {
    // ENOENT / permission — not worth surfacing on shutdown.
  }
}

/**
 * Read a runtime.json from `<workspace>/.agentproto/`. Returns the
 * parsed object (no validation) plus the on-disk mtime, or null when
 * the file is missing / unreadable / malformed.
 */
export async function readRuntimeMeta(workspace: string): Promise<{
  meta: Partial<RuntimeMeta> & Record<string, unknown>
  mtime: Date
} | null> {
  const path = join(workspace, ".agentproto", "runtime.json")
  try {
    const [raw, st] = await Promise.all([readFile(path, "utf8"), stat(path)])
    const meta = JSON.parse(raw) as Record<string, unknown>
    return { meta, mtime: st.mtime }
  } catch {
    return null
  }
}

/**
 * For each `workspace` path, check whether its runtime.json points
 * at a now-dead PID; if so, delete it. Returns the list of paths
 * that were cleaned. Called by `agentproto serve` at boot to keep
 * the discovery layer's view of "live daemons" honest — a stale
 * file with the same port as the new daemon is the classic source
 * of `sessions_unauthorized` 401s.
 *
 * Skips the running daemon's own workspace (passed in as
 * `currentWorkspace`) since that file is OURS to write.
 */
export async function sweepStaleRuntimeMetas(
  workspaces: readonly string[],
  currentWorkspace: string,
): Promise<string[]> {
  const cleaned: string[] = []
  for (const ws of workspaces) {
    if (ws === currentWorkspace) continue
    const meta = await readRuntimeMeta(ws)
    if (!meta) continue
    const pid = meta.meta.pid
    if (typeof pid === "number" && !isPidAlive(pid)) {
      try {
        await unlink(join(ws, ".agentproto", "runtime.json"))
        cleaned.push(join(ws, ".agentproto", "runtime.json"))
      } catch {
        // ignore — best-effort
      }
    }
  }
  return cleaned
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "EPERM") return true // exists, foreign user
    return false
  }
}
