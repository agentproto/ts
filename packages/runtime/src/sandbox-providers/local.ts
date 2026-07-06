/**
 * Built-in `local` sandbox provider — a passthrough that boots a real
 * agentproto daemon on 127.0.0.1 in a fresh temp workspace dir, rather than
 * a cloud box. Lets `sandbox: "local"` (and the rest of this family's
 * plumbing) be exercised without any cloud credentials: the same
 * `boot()` → `mcpUrl` → `connectDaemonAgentSessionHost` seam every other
 * provider goes through, just pointed at a child process instead of
 * e2b/modal/daytona.
 *
 * Spawns the `agentproto` binary already on PATH (the same CLI a developer
 * would use to run this daemon in the first place) — this package
 * deliberately has no dependency on `@agentproto/cli` (that dependency runs
 * the other way).
 */

import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type {
  BootedSandbox,
  SandboxBootOpts,
  SandboxProvider,
  SandboxSpec,
} from "@agentproto/sandbox"

const HEALTH_TIMEOUT_MS = 15_000
const POLL_INTERVAL_MS = 250

/** Built-in, zero-credential sandbox provider — see module docs. */
export const localSandboxProvider: SandboxProvider = {
  async boot(_spec: SandboxSpec, opts: SandboxBootOpts): Promise<BootedSandbox> {
    const port = await getFreePort()
    const workspace = await mkdtemp(join(tmpdir(), "agentproto-sandbox-local-"))

    const child = spawn(
      "agentproto",
      ["serve", "--port", String(port), "--bind", "127.0.0.1", "--workspace", workspace],
      {
        env: { ...process.env, ...opts.env },
        stdio: "ignore",
      },
    )
    let spawnErrorMessage: string | null = null
    child.once("error", (err) => {
      spawnErrorMessage = err.message
    })

    const healthUrl = `http://127.0.0.1:${port}/health`
    const ready = await probeHealth(healthUrl, HEALTH_TIMEOUT_MS)
    if (!ready) {
      if (child.exitCode === null) child.kill("SIGTERM")
      await rm(workspace, { recursive: true, force: true }).catch(() => {})
      throw new Error(
        spawnErrorMessage
          ? `@agentproto/runtime: local sandbox failed to spawn 'agentproto serve' — ` +
            `${spawnErrorMessage}. Is @agentproto/cli installed and on PATH?`
          : `@agentproto/runtime: local sandbox daemon did not become healthy at ` +
            `${healthUrl} within ${HEALTH_TIMEOUT_MS}ms.`,
      )
    }

    return {
      mcpUrl: `http://127.0.0.1:${port}/mcp`,
      sandboxId: `local-${randomUUID()}`,
      async stop(): Promise<void> {
        if (child.exitCode === null) child.kill("SIGTERM")
        await rm(workspace, { recursive: true, force: true }).catch(() => {})
      },
    }
  },
}

/** Allocate an OS-assigned free TCP port on loopback. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address()
      if (address === null || typeof address === "string") {
        srv.close(() => reject(new Error("failed to allocate a free port")))
        return
      }
      const { port } = address
      srv.close(() => resolve(port))
    })
  })
}

/** Poll `url` until it responds OK, or return false once `timeoutMs` elapses. */
async function probeHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(POLL_INTERVAL_MS) })
      if (res.ok) return true
    } catch {
      // not up yet — fall through to the deadline check
    }
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}
