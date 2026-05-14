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
 *    `POST /sessions/terminal` route + MCP `start_terminal_session`
 *    tool use this factory to register PTY-backed sessions in the
 *    daemon's registry.
 *
 * Both consumers agree on the same minimal `PtyProcess` shape
 * (defined in `@agentproto/acp/tunnel`); the function we return here
 * satisfies both their `spawnPty` option types structurally.
 */

import type { PtyProcess } from "@agentproto/acp/tunnel"

export interface PtyFactoryOptions {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  cols: number
  rows: number
}

export type PtyFactory = (opts: PtyFactoryOptions) => PtyProcess

export async function loadNodePtyFactory(): Promise<PtyFactory | null> {
  try {
    const nodePtyMod = await import("node-pty")
    // node-pty is CJS — `import()` wraps the module under `.default` in ESM.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodePty = (nodePtyMod as any).default ?? nodePtyMod
    if (typeof nodePty.spawn !== "function") return null
    return (opts) => {
      const pty = nodePty.spawn(opts.command, opts.args, {
        name: "xterm-256color",
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: {
          ...(process.env as Record<string, string>),
          ...(opts.env ?? {}),
        },
      })
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
