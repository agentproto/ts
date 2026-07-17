/**
 * Shared PTY factory loader.
 *
 * `node-pty` is an optional native dep — when present, the factory
 * returns a function that spawns child processes under a real PTY
 * (so ANSI escapes, alt-screen apps, key bindings and resize all
 * work). When absent, returns null and callers degrade to
 * `child_process.spawn` (no PTY).
 *
 * Two consumers today:
 *  - `createTunnelServer` (packages/acp/src/tunnel/server.ts) — cloud-
 *    dispatched spawns over the tunnel use this factory when the
 *    spawn frame requests `pty: true`.
 *  - `createGateway` (packages/runtime/src/index.ts) — local
 *    `POST /sessions/terminal` route + MCP `terminal_start`
 *    tool use this factory to register PTY-backed sessions in the
 *    daemon's registry.
 *
 * Both consumers agree on the same minimal `PtyProcess` shape
 * (defined in `@agentproto/acp/tunnel`); the function we return here
 * satisfies both their `spawnPty` option types structurally.
 */

import type { PtyProcess } from "@agentproto/acp/tunnel"
import { accessSync, chmodSync, constants as fsConstants, existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

export interface PtyFactoryOptions {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  cols: number
  rows: number
}

export type PtyFactory = (opts: PtyFactoryOptions) => PtyProcess

// ── node-pty spawn-helper self-heal ────────────────────────────────────
//
// node-pty ships a tiny `spawn-helper` binary that it `posix_spawn`s on
// macOS/Linux to set the controlling tty before exec'ing the target. If that
// helper isn't executable, EVERY spawn fails with the opaque `posix_spawnp
// failed.` — regardless of the target binary, cwd, fds, or env, which is what
// makes it so hard to diagnose. pnpm's content-addressable store has been
// observed extracting/hard-linking the prebuilt helper without preserving
// mode 0755 (macOS/APFS), leaving a 0644 helper that breaks every PTY spawn.

/** The on-disk locations node-pty's `spawn-helper` can live at, relative to
 *  node-pty's own package dir: a 1.x install ships prebuilds per
 *  platform+arch; a source/`node-gyp` build lands it under build/Release. */
export function spawnHelperCandidates(nodePtyDir: string): string[] {
  return [
    join(nodePtyDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    join(nodePtyDir, "build", "Release", "spawn-helper"),
  ]
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Best-effort self-heal: restore the exec bit on node-pty's own
 *  `spawn-helper` when a package manager has dropped it. chmod-ing our OWN
 *  dependency's OWN binary is safe and idempotent — it only ever adds back
 *  the 0755 the prebuild is meant to ship with. Returns the paths it actually
 *  repaired (for logging and tests); missing or already-executable helpers
 *  are left untouched. */
export function ensureSpawnHelperExecutable(
  nodePtyDir: string,
  log: (message: string) => void = () => {},
): string[] {
  const repaired: string[] = []
  for (const helper of spawnHelperCandidates(nodePtyDir)) {
    if (!existsSync(helper) || isExecutable(helper)) continue
    try {
      chmodSync(helper, 0o755)
      repaired.push(helper)
      log(`[pty-factory] restored +x on non-executable node-pty spawn-helper: ${helper}`)
    } catch (err) {
      log(
        `[pty-factory] node-pty spawn-helper ${helper} is not executable and could not be ` +
          `repaired (${err instanceof Error ? err.message : String(err)}); PTY spawns will fail`,
      )
    }
  }
  return repaired
}

/** Rewrite node-pty's opaque spawn failure into a one-step-diagnosable
 *  message. A bare `posix_spawnp failed.` names neither errno nor cause; when
 *  the prebuilt spawn-helper is the culprit (present but non-executable) we
 *  name the exact path + fix, and we always attach the command + cwd. */
export function describeSpawnFailure(
  raw: unknown,
  ctx: { command: string; cwd?: string; nodePtyDir: string | null },
): string {
  const rawMessage = raw instanceof Error ? raw.message : String(raw)
  let hint = ""
  if (/posix_spawn/i.test(rawMessage) && ctx.nodePtyDir) {
    for (const helper of spawnHelperCandidates(ctx.nodePtyDir)) {
      if (existsSync(helper) && !isExecutable(helper)) {
        hint =
          ` — node-pty's spawn-helper at ${helper} is not executable; ` +
          `run \`chmod +x "${helper}"\` (pnpm can drop the exec bit on prebuilt binaries)`
        break
      }
    }
  }
  const where = ctx.cwd ? ` (cwd ${ctx.cwd})` : ""
  return `node-pty failed to spawn \`${ctx.command}\`${where}: ${rawMessage}${hint}`
}

/** Resolve node-pty's installed package directory, or null when it can't be
 *  located — in which case the self-heal + helper-aware diagnostics above are
 *  skipped (the raw error still surfaces, just without the helper hint). */
function resolveNodePtyDir(): string | null {
  try {
    const require = createRequire(import.meta.url)
    return dirname(require.resolve("node-pty/package.json"))
  } catch {
    return null
  }
}

export async function loadNodePtyFactory(
  log: (message: string) => void = message => console.warn(message),
): Promise<PtyFactory | null> {
  try {
    const nodePtyMod = await import("node-pty")
    // node-pty is CJS — `import()` wraps the module under `.default` in ESM.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodePty = (nodePtyMod as any).default ?? nodePtyMod
    if (typeof nodePty.spawn !== "function") return null
    const nodePtyDir = resolveNodePtyDir()
    // Restore the exec bit up front, once, so the very first PTY spawn doesn't
    // hit the opaque `posix_spawnp failed.` a stripped helper would cause.
    if (nodePtyDir) ensureSpawnHelperExecutable(nodePtyDir, log)
    return (opts) => {
      let pty
      try {
        pty = nodePty.spawn(opts.command, opts.args, {
          name: "xterm-256color",
          cols: opts.cols,
          rows: opts.rows,
          cwd: opts.cwd,
          env: {
            ...(process.env as Record<string, string>),
            ...(opts.env ?? {}),
          },
        })
      } catch (err) {
        // node-pty throws a bare `posix_spawnp failed.` with no errno/cause;
        // enrich it so the operator surfaces (POST /sessions/terminal,
        // MCP terminal_start) can point straight at the fix.
        throw new Error(
          describeSpawnFailure(err, { command: opts.command, cwd: opts.cwd, nodePtyDir }),
        )
      }
      const proc: PtyProcess = {
        get pid() {
          return pty.pid
        },
        write(data: string) {
          pty.write(data)
        },
        resize(cols: number, rows: number) {
          pty.resize(cols, rows)
        },
        kill(signal?: string) {
          pty.kill(signal)
        },
        onData(handler: (data: string) => void) {
          pty.onData(handler)
        },
        onExit(handler: (event: { exitCode: number; signal?: number }) => void) {
          pty.onExit(handler)
        },
      }
      return proc
    }
  } catch {
    return null
  }
}
