/**
 * POST /sandboxes/exec — the daemon route behind `agentproto sandbox exec`.
 * Real HTTP layer via `startHttpServer`, fake sandbox provider.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"
import type { BootedSandbox, SandboxProvider } from "@agentproto/sandbox"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"

function fakeHandle(provider: SandboxProvider): SandboxProviderHandle {
  return {
    provider,
    slug: "fake",
    name: "Fake",
    version: "test",
    description: "test double",
    requiresSetup: false,
    capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
    async check() {
      return true
    },
  }
}

describe("POST /sandboxes/exec", () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agentproto-sbx-exec-"))
    process.env.AGENTPROTO_SANDBOX_LEDGER = join(workspace, "sandboxes.json")
  })
  afterEach(async () => {
    delete process.env.AGENTPROTO_SANDBOX_LEDGER
    await rm(workspace, { recursive: true, force: true })
  })

  async function withServer(
    booted: Partial<BootedSandbox>,
    fn: (base: string) => Promise<void>,
  ): Promise<void> {
    const provider: SandboxProvider = {
      async boot() {
        return { mcpUrl: "m", sandboxId: "sbx_http", stop: async () => {}, ...booted } as BootedSandbox
      },
    }
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () =>
        (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
      resolveSandboxProvider: async slug => (slug === "fake" ? fakeHandle(provider) : null),
    })
    try {
      await fn(`http://127.0.0.1:${port}`)
    } finally {
      await http.stop()
    }
  }

  const post = (base: string, body: unknown) =>
    fetch(`${base}/sandboxes/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  it("runs the command and returns the exec result (200)", async () => {
    const exec = vi.fn(async () => ({ exitCode: 7, stdout: "out", stderr: "err", durationMs: 3 }))
    await withServer({ exec }, async base => {
      const res = await post(base, { provider: "fake", command: "false", env: { A: "1" } })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; result: { exitCode: number; stdout: string } }
      expect(body.ok).toBe(true)
      expect(body.result.exitCode).toBe(7)
      expect(body.result.stdout).toBe("out")
    })
    expect(exec).toHaveBeenCalledWith(expect.objectContaining({ command: "false", env: { A: "1" } }))
  })

  it("answers 422 with the failure code + redacted message when exec fails", async () => {
    const secret = "tok-0123456789-abcdef"
    const exec = async () => {
      throw new Error(`denied for ${secret}`)
    }
    await withServer({ exec }, async base => {
      const res = await post(base, { provider: "fake", command: "x", env: { MY_API_TOKEN: secret } })
      expect(res.status).toBe(422)
      const text = await res.text()
      expect(text).not.toContain(secret)
      expect(JSON.parse(text)).toMatchObject({ ok: false, code: "sandbox_exec_failed" })
    })
  })

  it("answers 422 for envProfiles on an unknown profile (no secret lookup by raw ref)", async () => {
    await withServer({ exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }) }, async base => {
      const res = await post(base, {
        provider: "fake",
        command: "x",
        envProfiles: { SOME_KEY: "definitely-not-a-profile-id" },
      })
      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({ ok: false, code: "sandbox_exec_env_profile" })
    })
  })

  it("answers 400 on an invalid body", async () => {
    await withServer({}, async base => {
      const res = await post(base, { command: "no provider" })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ ok: false, code: "sandbox_exec_invalid_input" })
    })
  })

  it("is POST-only", async () => {
    await withServer({}, async base => {
      const res = await fetch(`${base}/sandboxes/exec`)
      expect(res.status).toBe(404)
    })
  })
})

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function noopConversations(): ConversationStore {
  return {
    async open() {},
    async appendTurn() {},
    async read() {
      return { meta: {} as never, turns: [] }
    },
    async list() {
      return []
    },
    pathFor: (id: string) => id,
  }
}

function noopHeartbeat(): HeartbeatRunner {
  return {
    start() {},
    stop() {},
    async fireNow() {},
  }
}
