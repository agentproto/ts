/**
 * User-preset (favorite) authoring over HTTP — makes the CLI-only `agentproto
 * preset save/delete` reachable off the daemon's REST surface, unblocking the
 * VS Code "Save as favorite…" action and the pinned-favorites spawn flow.
 * Exercises the real REST layer via `startHttpServer`, same pattern as
 * workspaces-http-routes.test.ts.
 *
 * `loadUserPresets`/`saveUserPreset` always resolve against
 * `~/.agentproto/presets.json` — no path override — so every test runs with
 * `HOME` pointed at a throwaway tmp dir (Node's `os.homedir()` reads `$HOME`
 * on POSIX) and restores it afterward.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

interface UserPresetShape {
  id: string
  label: string
  adapter?: string
  model?: string
  cwd?: string
  skills?: string[]
}

describe("user-preset (favorite) authoring — REST routes", () => {
  let realHome: string | undefined
  let fakeHome: string

  beforeEach(() => {
    realHome = process.env.HOME
    fakeHome = mkdtempSync(join(tmpdir(), "agentproto-fakehome-"))
    process.env.HOME = fakeHome
  })

  afterEach(() => {
    process.env.HOME = realHome
    rmSync(fakeHome, { recursive: true, force: true })
  })

  async function withServer(
    fn: (base: string) => Promise<void>,
    token?: string,
  ): Promise<void> {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      ...(token ? { token } : {}),
      mcpServerFactory: async () =>
        (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      await fn(`http://127.0.0.1:${port}`)
    } finally {
      await http.stop()
    }
  }

  it("POST /user-presets creates a favorite, GET reflects it, and re-POST upserts by id", async () => {
    await withServer(async base => {
      const createRes = await fetch(`${base}/user-presets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "fast-opus",
          label: "Fast Opus",
          adapter: "claude-code",
          model: "opus",
          cwd: "/tmp",
          skills: ["agentproto"],
        }),
      })
      expect(createRes.status).toBe(200)
      const created = (await createRes.json()) as { preset: UserPresetShape }
      expect(created.preset).toMatchObject({
        id: "fast-opus",
        label: "Fast Opus",
        adapter: "claude-code",
        model: "opus",
        cwd: "/tmp",
        skills: ["agentproto"],
      })

      // GET reflects the write.
      const listRes = await fetch(`${base}/user-presets`)
      const listed = (await listRes.json()) as { presets: UserPresetShape[] }
      expect(listed.presets).toHaveLength(1)
      expect(listed.presets[0]!.id).toBe("fast-opus")

      // Re-POST same id upserts (label changed, still one entry).
      const upsertRes = await fetch(`${base}/user-presets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "fast-opus", label: "Fast Opus (renamed)" }),
      })
      expect(upsertRes.status).toBe(200)
      const afterUpsert = (await (await fetch(`${base}/user-presets`)).json()) as {
        presets: UserPresetShape[]
      }
      expect(afterUpsert.presets).toHaveLength(1)
      expect(afterUpsert.presets[0]!.label).toBe("Fast Opus (renamed)")
    })
  })

  it("POST /user-presets rejects an invalid body with 400 invalid_input", async () => {
    await withServer(async base => {
      // Upper-case id violates the daemon's `^[a-z0-9][a-z0-9-]*$` rule.
      const badId = await fetch(`${base}/user-presets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "Bad Id", label: "x" }),
      })
      expect(badId.status).toBe(400)
      expect((await badId.json()) as { error: string }).toMatchObject({
        error: "invalid_input",
      })

      // Missing label (required) also fails validation.
      const noLabel = await fetch(`${base}/user-presets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "ok" }),
      })
      expect(noLabel.status).toBe(400)

      // Nothing was persisted.
      const listed = (await (await fetch(`${base}/user-presets`)).json()) as {
        presets: UserPresetShape[]
      }
      expect(listed.presets).toHaveLength(0)
    })
  })

  it("DELETE /user-presets/:id removes a favorite; 404s on an unknown id", async () => {
    await withServer(async base => {
      await fetch(`${base}/user-presets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "throwaway", label: "Throwaway" }),
      })

      const delRes = await fetch(`${base}/user-presets/throwaway`, { method: "DELETE" })
      expect(delRes.status).toBe(200)
      expect((await delRes.json()) as { deleted: boolean }).toMatchObject({ deleted: true })

      const listed = (await (await fetch(`${base}/user-presets`)).json()) as {
        presets: UserPresetShape[]
      }
      expect(listed.presets).toHaveLength(0)

      const missing = await fetch(`${base}/user-presets/ghost`, { method: "DELETE" })
      expect(missing.status).toBe(404)
    })
  })

  it("gates the mutating routes behind the per-boot token, same as /sessions/* and /workspaces", async () => {
    const TOKEN = "test-secret-token"
    await withServer(async base => {
      const noAuthPost = await fetch(`${base}/user-presets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "gated", label: "Gated" }),
      })
      expect(noAuthPost.status).toBe(401)

      const withAuthPost = await fetch(`${base}/user-presets`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ id: "gated", label: "Gated" }),
      })
      expect(withAuthPost.status).toBe(200)

      const noAuthDelete = await fetch(`${base}/user-presets/gated`, { method: "DELETE" })
      expect(noAuthDelete.status).toBe(401)

      // GET stays ungated (loopback read), same as the existing route.
      const getRes = await fetch(`${base}/user-presets`)
      expect(getRes.status).toBe(200)
    }, TOKEN)
  })
})

// ── tiny stubs (mirror workspaces-http-routes.test.ts) ──

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
