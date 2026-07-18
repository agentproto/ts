/**
 * Workspace registry mutation over HTTP — makes `agentproto workspace
 * add/remove/use` reachable off the CLI (POST /workspaces, PUT
 * /workspaces/active, DELETE /workspaces/:slug), unblocking the VS Code
 * "create workspace here" CTA. Exercises the real REST layer via
 * `startHttpServer`, same pattern as pending-permissions.test.ts.
 *
 * `loadWorkspacesConfig`/`saveWorkspacesConfig` always resolve against
 * `~/.agentproto/workspaces.json` — the daemon doesn't take a path
 * override. To keep this test off the real file, every test in this
 * suite runs with `HOME` pointed at a throwaway tmp dir (Node's
 * `os.homedir()` reads `$HOME` on POSIX) and restores it afterward.
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

describe("workspace registry mutation — REST routes", () => {
  let realHome: string | undefined
  let fakeHome: string
  let dirA: string
  let dirB: string

  beforeEach(() => {
    realHome = process.env.HOME
    fakeHome = mkdtempSync(join(tmpdir(), "agentproto-fakehome-"))
    process.env.HOME = fakeHome
    dirA = mkdtempSync(join(tmpdir(), "agentproto-ws-a-"))
    dirB = mkdtempSync(join(tmpdir(), "agentproto-ws-b-"))
  })

  afterEach(() => {
    process.env.HOME = realHome
    rmSync(fakeHome, { recursive: true, force: true })
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
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

  it("POST /workspaces adds a workspace (first add becomes active) and upserts on re-add", async () => {
    await withServer(async base => {
      const addRes = await fetch(`${base}/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: dirA, slug: "proj" }),
      })
      expect(addRes.status).toBe(201)
      const added = (await addRes.json()) as {
        active?: string
        workspaces: Array<{ slug: string; path: string; label?: string }>
      }
      expect(added.active).toBe("proj")
      expect(added.workspaces).toEqual([
        expect.objectContaining({ slug: "proj", path: dirA }),
      ])

      // GET reflects the write.
      const listRes = await fetch(`${base}/workspaces`)
      const listed = (await listRes.json()) as typeof added
      expect(listed.workspaces).toHaveLength(1)

      // Re-POST with the same slug upserts (label added, still one entry).
      const upsertRes = await fetch(`${base}/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: dirA, slug: "proj", label: "My Project" }),
      })
      expect(upsertRes.status).toBe(201)
      const upserted = (await upsertRes.json()) as typeof added
      expect(upserted.workspaces).toHaveLength(1)
      expect(upserted.workspaces[0]).toMatchObject({
        slug: "proj",
        path: dirA,
        label: "My Project",
      })
    })
  })

  it("POST /workspaces defaults slug to the path's basename when omitted", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: dirA }),
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as { workspaces: Array<{ slug: string }> }
      // dirA's basename, sanitised, is a non-empty lowercase slug.
      expect(body.workspaces[0]!.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/)
    })
  })

  it("POST /workspaces sanitises an arbitrary slug", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: dirA, slug: "My Project!!" }),
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as { workspaces: Array<{ slug: string }> }
      expect(body.workspaces[0]!.slug).toBe("my-project")
    })
  })

  it("POST /workspaces rejects a missing, non-absolute, or nonexistent path", async () => {
    await withServer(async base => {
      const missing = await fetch(`${base}/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "x" }),
      })
      expect(missing.status).toBe(400)
      expect((await missing.json()) as { error: string }).toMatchObject({
        error: "missing_path",
      })

      const relative = await fetch(`${base}/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "relative/path" }),
      })
      expect(relative.status).toBe(400)
      expect((await relative.json()) as { error: string }).toMatchObject({
        error: "workspace_path_not_absolute",
      })

      const nonexistent = await fetch(`${base}/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: join(dirA, "does-not-exist") }),
      })
      expect(nonexistent.status).toBe(400)
      expect((await nonexistent.json()) as { error: string }).toMatchObject({
        error: "workspace_path_not_found",
      })
    })
  })

  it("DELETE /workspaces/:slug removes it and reassigns active; 404s on an unknown slug", async () => {
    await withServer(async base => {
      await fetch(`${base}/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: dirA, slug: "a" }),
      })
      await fetch(`${base}/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: dirB, slug: "b" }),
      })

      const delRes = await fetch(`${base}/workspaces/a`, { method: "DELETE" })
      expect(delRes.status).toBe(200)
      const after = (await delRes.json()) as {
        active?: string
        workspaces: Array<{ slug: string }>
      }
      expect(after.workspaces.map(w => w.slug)).toEqual(["b"])
      // "a" was active (first add); removing it hands off to whatever's left.
      expect(after.active).toBe("b")

      const notFound = await fetch(`${base}/workspaces/ghost`, { method: "DELETE" })
      expect(notFound.status).toBe(404)
      expect((await notFound.json()) as { error: string }).toMatchObject({
        error: "workspace_not_found",
      })
    })
  })

  it("PUT /workspaces/active sets the active workspace; 404s on an unknown slug", async () => {
    await withServer(async base => {
      await fetch(`${base}/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: dirA, slug: "a" }),
      })
      await fetch(`${base}/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: dirB, slug: "b" }),
      })

      const putRes = await fetch(`${base}/workspaces/active`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "b" }),
      })
      expect(putRes.status).toBe(200)
      const body = (await putRes.json()) as { active?: string }
      expect(body.active).toBe("b")

      const missing = await fetch(`${base}/workspaces/active`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "ghost" }),
      })
      expect(missing.status).toBe(404)
      expect((await missing.json()) as { error: string }).toMatchObject({
        error: "workspace_not_found",
      })
    })
  })

  it("gates all three mutating routes behind the per-boot token, same as /sessions/*", async () => {
    const TOKEN = "test-secret-token"
    await withServer(async base => {
      const noAuthPost = await fetch(`${base}/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: dirA }),
      })
      expect(noAuthPost.status).toBe(401)

      const withAuthPost = await fetch(`${base}/workspaces`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ path: dirA, slug: "gated" }),
      })
      expect(withAuthPost.status).toBe(201)

      const noAuthPut = await fetch(`${base}/workspaces/active`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "gated" }),
      })
      expect(noAuthPut.status).toBe(401)

      const noAuthDelete = await fetch(`${base}/workspaces/gated`, {
        method: "DELETE",
      })
      expect(noAuthDelete.status).toBe(401)
    }, TOKEN)
  })
})

// ── tiny stubs (mirror pending-permissions.test.ts) ──

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
