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
 * The `.agentproto/` dir is safe to gitignore. We don't write any
 * secrets here today; if pairing tokens land later they'll be
 * mode-0600 and called out explicitly in the README.
 */

import { mkdir, writeFile } from "node:fs/promises"
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
    await writeFile(
      join(dir, "runtime.json"),
      JSON.stringify(meta, null, 2) + "\n",
      "utf8",
    )
  } catch (err) {
    console.error("[runtime] failed to write .agentproto/runtime.json:", err)
  }
}
