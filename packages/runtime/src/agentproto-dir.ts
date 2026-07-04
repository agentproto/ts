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
 * The same snapshot is ALSO mirrored to the central, workspace-
 * independent daemon registry at `~/.agentproto/daemons/<port>.json`
 * (see daemonRegistryDir / writeDaemonRegistryEntry below). The
 * per-workspace file only helps `cat`-style local diagnostics and
 * discovery for REGISTERED workspaces; a daemon launched from an
 * arbitrary cwd (tunnel mode, a repo checkout) writes its workspace
 * file somewhere discovery never walks. The central entry is what
 * makes `agentproto chat` / `sessions` find such a daemon.
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

import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

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
  // Also publish to the central daemon registry so the CLI can discover
  // this daemon WITHOUT its workspace being registered in
  // workspaces.json. A daemon launched from an arbitrary cwd (the common
  // case: `agentproto serve` from a repo checkout, or tunnel mode) lands
  // its workspace runtime.json somewhere discovery never walks; the
  // central entry closes that gap. Keyed by port so multiple daemons
  // coexist. Best-effort — the workspace file above is the source of
  // truth; this is purely an additional discovery hint.
  await writeDaemonRegistryEntry(meta)
}

/** `~/.agentproto/daemons/` — the central, workspace-independent daemon
 *  registry. Each live daemon owns one `<port>.json` here. */
export function daemonRegistryDir(): string {
  return resolve(homedir(), ".agentproto", "daemons")
}

function daemonRegistryPath(port: number): string {
  return join(daemonRegistryDir(), `${port}.json`)
}

/**
 * Write `<registry>/<port>.json` (mode 0600 — holds the bearer token).
 * Best-effort; failure here never gates the gateway. Mirrors the
 * per-workspace runtime.json so the same `RuntimeMeta` shape is readable
 * from either location.
 */
export async function writeDaemonRegistryEntry(meta: RuntimeMeta): Promise<void> {
  try {
    await mkdir(daemonRegistryDir(), { recursive: true })
    await writeFile(
      daemonRegistryPath(meta.port),
      JSON.stringify(meta, null, 2) + "\n",
      { encoding: "utf8", mode: 0o600 },
    )
  } catch (err) {
    console.error("[runtime] failed to write daemons/<port>.json:", err)
  }
}

/** Remove a daemon's central registry entry. Best-effort; missing is a
 *  no-op. Called from graceful shutdown alongside unlinkRuntimeMeta. */
export async function unlinkDaemonRegistryEntry(port: number): Promise<void> {
  try {
    await unlink(daemonRegistryPath(port))
  } catch {
    // ENOENT / permission — not worth surfacing on shutdown.
  }
}

/**
 * Read every entry in the central daemon registry, newest-first by
 * `startedAt`. No liveness filtering here — callers decide (discovery
 * skips dead PIDs; the sweep deletes them). Malformed / unreadable
 * entries are skipped silently.
 */
export async function readDaemonRegistry(): Promise<
  Array<{ meta: Partial<RuntimeMeta> & Record<string, unknown>; path: string; mtime: Date }>
> {
  let names: string[]
  try {
    names = await readdir(daemonRegistryDir())
  } catch {
    return [] // registry dir doesn't exist yet — no daemons published.
  }
  const out: Array<{
    meta: Partial<RuntimeMeta> & Record<string, unknown>
    path: string
    mtime: Date
  }> = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const path = join(daemonRegistryDir(), name)
    try {
      const [raw, st] = await Promise.all([readFile(path, "utf8"), stat(path)])
      out.push({ meta: JSON.parse(raw) as Record<string, unknown>, path, mtime: st.mtime })
    } catch {
      // skip malformed / unreadable
    }
  }
  // Newest daemon first — discovery prefers the most recently booted.
  return out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
}

/**
 * Delete central registry entries whose PID is dead (kill -9, crash,
 * reboot). Returns the paths cleaned. Called at `serve` boot — the same
 * footgun the per-workspace sweep guards against, applied to the central
 * registry. Skips `currentPort` (the booting daemon's own entry).
 */
export async function sweepStaleDaemonRegistry(currentPort: number): Promise<string[]> {
  const cleaned: string[] = []
  for (const entry of await readDaemonRegistry()) {
    if (entry.meta.port === currentPort) continue
    const pid = entry.meta.pid
    if (typeof pid === "number" && !isPidAlive(pid)) {
      try {
        await unlink(entry.path)
        cleaned.push(entry.path)
      } catch {
        // ignore — best-effort
      }
    }
  }
  return cleaned
}

/**
 * Delete `<workspace>/.agentproto/runtime.json`. Best-effort — called
 * from the daemon's graceful shutdown path so a CLI looking for the
 * live daemon doesn't pick up a stale token after this process exits.
 * Missing file is a no-op (the daemon may never have written one).
 */
export async function unlinkRuntimeMeta(
  workspace: string,
  port?: number,
): Promise<void> {
  try {
    await unlink(join(workspace, ".agentproto", "runtime.json"))
  } catch {
    // ENOENT / permission — not worth surfacing on shutdown.
  }
  // Tear down the matching central registry entry too (when the caller
  // knows the port) so discovery doesn't pick up a dead daemon.
  if (typeof port === "number") await unlinkDaemonRegistryEntry(port)
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
