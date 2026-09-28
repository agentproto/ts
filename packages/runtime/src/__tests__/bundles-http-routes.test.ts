/**
 * Capability-bundle authoring over HTTP (PLAN D phase 1) — the REST twin of
 * `bundle_list`/`bundle_create`/`bundle_update`/`bundle_delete`. Exercises
 * the real REST layer via `startHttpServer`, same pattern as
 * user-presets-http-routes.test.ts.
 *
 * `loadBundles`/`createBundle`/etc always resolve against
 * `~/.agentproto/bundles.json` — no path override — so every test runs with
 * `HOME` pointed at a throwaway tmp dir and restores it afterward.
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

interface BundleShape {
  id: string
  label: string
  mcpImports: string[]
  includeDaemon?: boolean
  skills: string[]
  dangling?: string[]
}

describe("capability bundles — REST routes", () => {
  let realHome: string | undefined
  let fakeHome: string

  beforeEach(() => {
    realHome = process.env.HOME
    fakeHome = mkdtempSync(join(tmpdir(), "agentproto-fakehome-bundles-"))
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

  it("POST /bundles creates a bundle, GET reflects it (with dangling: [])", async () => {
    await withServer(async base => {
      const createRes = await fetch(`${base}/bundles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "research", label: "Research", skills: ["dataviz"] }),
      })
      expect(createRes.status).toBe(201)
      const created = (await createRes.json()) as { bundle: BundleShape }
      expect(created.bundle).toMatchObject({ id: "research", label: "Research", skills: ["dataviz"] })

      const listRes = await fetch(`${base}/bundles`)
      const listed = (await listRes.json()) as { bundles: BundleShape[] }
      expect(listed.bundles).toHaveLength(1)
      expect(listed.bundles[0]).toMatchObject({ id: "research", dangling: [] })
    })
  })

  it("POST /bundles rejects an unknown mcpImports id with 400 invalid_input", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/bundles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "research", label: "Research", mcpImports: ["ghost"] }),
      })
      expect(res.status).toBe(400)
      expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_input" })

      const listed = (await (await fetch(`${base}/bundles`)).json()) as { bundles: BundleShape[] }
      expect(listed.bundles).toHaveLength(0)
    })
  })

  it("POST /bundles rejects a duplicate id — use PUT to update", async () => {
    await withServer(async base => {
      await fetch(`${base}/bundles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "research", label: "Research" }),
      })
      const dup = await fetch(`${base}/bundles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "research", label: "Again" }),
      })
      expect(dup.status).toBe(400)
    })
  })

  it("PUT /bundles/:id merges onto the existing bundle; 404s an unknown id", async () => {
    await withServer(async base => {
      await fetch(`${base}/bundles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "research", label: "Research", skills: ["dataviz"] }),
      })
      const updateRes = await fetch(`${base}/bundles/research`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ includeDaemon: true }),
      })
      expect(updateRes.status).toBe(200)
      const updated = (await updateRes.json()) as { bundle: BundleShape }
      expect(updated.bundle).toMatchObject({ id: "research", label: "Research", includeDaemon: true, skills: ["dataviz"] })

      const missing = await fetch(`${base}/bundles/ghost`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "x" }),
      })
      expect(missing.status).toBe(404)
    })
  })

  it("DELETE /bundles/:id removes a bundle; 404s on an unknown id", async () => {
    await withServer(async base => {
      await fetch(`${base}/bundles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "throwaway", label: "Throwaway" }),
      })

      const delRes = await fetch(`${base}/bundles/throwaway`, { method: "DELETE" })
      expect(delRes.status).toBe(200)
      expect((await delRes.json()) as { deleted: boolean }).toMatchObject({ deleted: true })

      const listed = (await (await fetch(`${base}/bundles`)).json()) as { bundles: BundleShape[] }
      expect(listed.bundles).toHaveLength(0)

      const missing = await fetch(`${base}/bundles/ghost`, { method: "DELETE" })
      expect(missing.status).toBe(404)
    })
  })

  it("flags a dangling mcpImports id once the underlying import is removed", async () => {
    await withServer(async base => {
      // Import via the daemon-internal store directly (no HTTP route needed
      // for this fixture — /mcps/imports is exercised elsewhere).
      const { saveImportedMcps, addImport } = await import("../mcp-imports.js")
      await saveImportedMcps(
        addImport(
          { version: 1, imports: [] },
          {
            snapshot: {
              id: "imp1",
              source: "workspace",
              scope: "global",
              name: "chrome-devtools",
              type: "stdio",
              command: "npx",
            },
          },
        ),
      )
      await fetch(`${base}/bundles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "research", label: "Research", mcpImports: ["imp1"] }),
      })

      // Remove the import out from under the bundle.
      const { removeImport, loadImportedMcps } = await import("../mcp-imports.js")
      await saveImportedMcps(removeImport(await loadImportedMcps(), "imp1"))

      const listed = (await (await fetch(`${base}/bundles`)).json()) as { bundles: BundleShape[] }
      expect(listed.bundles[0]).toMatchObject({ id: "research", dangling: ["imp1"] })
    })
  })

  it("gates the mutating routes behind the per-boot token, same as /user-presets", async () => {
    const TOKEN = "test-secret-token"
    await withServer(async base => {
      const noAuthPost = await fetch(`${base}/bundles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "gated", label: "Gated" }),
      })
      expect(noAuthPost.status).toBe(401)

      const withAuthPost = await fetch(`${base}/bundles`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ id: "gated", label: "Gated" }),
      })
      expect(withAuthPost.status).toBe(201)

      const noAuthPut = await fetch(`${base}/bundles/gated`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "x" }),
      })
      expect(noAuthPut.status).toBe(401)

      const noAuthDelete = await fetch(`${base}/bundles/gated`, { method: "DELETE" })
      expect(noAuthDelete.status).toBe(401)

      // GET stays ungated (loopback read), same as /user-presets.
      const getRes = await fetch(`${base}/bundles`)
      expect(getRes.status).toBe(200)
    }, TOKEN)
  })
})

// ── tiny stubs (mirror user-presets-http-routes.test.ts) ──

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
