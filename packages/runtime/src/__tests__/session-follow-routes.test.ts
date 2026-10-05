/**
 * End-to-end over a real in-process daemon: `POST|GET|DELETE /follows` and the
 * `session_follow` / `session_unfollow` / `session_follows` MCP tools share one
 * store + the same validation.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import { createGateway, type GatewayHandle } from "../index.js"
import type { AgentSessionLike } from "../sessions.js"

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function liveSession(): AgentSessionLike {
  return {
    sessionId: "acp_follow_routes",
    pid: process.pid,
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

describe("session-follow HTTP routes + MCP tools", () => {
  let workspace: string
  let gateway: GatewayHandle
  let followerId: string
  let mcp: Client

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${gateway.url}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${gateway.token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: res.status, json: (await res.json()) as Record<string, any> }
  }

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agentproto-follow-routes-"))
    gateway = await createGateway({
      workspace,
      specs: [],
      port: await freePort(),
      boot: false,
      persist: false,
      persistPath: join(workspace, "sessions.json"),
    })
    followerId = gateway.sessions.spawnAgent({
      workspaceSlug: "default",
      cwd: workspace,
      agentSession: liveSession(),
      adapterSlug: "claude-code",
    }).id
    mcp = new Client({ name: "follow-test", version: "0" })
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp?callerSessionId=${followerId}`), {
        requestInit: { headers: { authorization: `Bearer ${gateway.token}` } },
      }),
    )
  })

  afterAll(async () => {
    await mcp?.close()
    await gateway?.stop()
    await rm(workspace, { recursive: true, force: true })
  })

  it("POST creates (201), re-POST with the same key upserts (200, same id)", async () => {
    const first = await call("POST", "/follows", {
      follower: followerId,
      key: "watch-all",
      selector: { all: true },
      batchMs: 0,
    })
    expect(first.status).toBe(201)
    expect(first.json.id).toMatch(/^fol_/)
    expect(first.json).toMatchObject({
      key: "watch-all",
      follower: followerId,
      selector: { all: true, rootOnly: true },
      batchMs: 0,
      skipEmptyTurns: true,
      excludeFollowerChildren: true,
    })
    expect(first.json.events).toEqual(["turn-end", "awaiting-input", "exited", "crashed", "pr-opened", "pr-merged"])

    const second = await call("POST", "/follows", {
      follower: followerId,
      key: "watch-all",
      selector: { all: true },
      batchMs: 500,
    })
    expect(second.status).toBe(200)
    expect(second.json.id).toBe(first.json.id)
    expect(second.json.createdAt).toBe(first.json.createdAt)
    expect(second.json.batchMs).toBe(500)
  })

  it("GET lists, optionally filtered by follower", async () => {
    const all = await call("GET", "/follows")
    expect(all.status).toBe(200)
    expect(all.json.follows.map((f: { key?: string }) => f.key)).toContain("watch-all")
    const mine = await call("GET", `/follows?follower=${encodeURIComponent(followerId)}`)
    expect(mine.json.follows.length).toBeGreaterThan(0)
    const none = await call("GET", "/follows?follower=sess_nobody")
    expect(none.json.follows).toEqual([])
  })

  it("POST validation: unknown follower 404, empty selector 400, bad body 400", async () => {
    const gone = await call("POST", "/follows", { follower: "sess_missing", selector: { all: true } })
    expect(gone.status).toBe(404)
    expect(gone.json.error).toBe("session_not_found")

    const noSel = await call("POST", "/follows", { follower: followerId, selector: {} })
    expect(noSel.status).toBe(400)
    expect(noSel.json.error).toBe("invalid_selector")

    const emptyIds = await call("POST", "/follows", { follower: followerId, selector: { sessionIds: [] } })
    expect(emptyIds.status).toBe(400)

    const badEvent = await call("POST", "/follows", {
      follower: followerId,
      selector: { all: true },
      events: ["nope"],
    })
    expect(badEvent.status).toBe(400)
    expect(badEvent.json.error).toBe("invalid_input")

    const noFollower = await call("POST", "/follows", { selector: { all: true } })
    expect(noFollower.status).toBe(400)
    expect(noFollower.json.error).toBe("no_follower")

    const notObject = await call("POST", "/follows", [1, 2])
    expect(notObject.status).toBe(400)
  })

  it("DELETE removes by key or id; unknown is 404", async () => {
    const made = await call("POST", "/follows", { follower: followerId, selector: { cwdPrefix: "/x" } })
    expect(made.status).toBe(201)
    const byId = await call("DELETE", `/follows/${made.json.id}`)
    expect(byId.status).toBe(200)
    expect(byId.json).toEqual({ ok: true, id: made.json.id })

    const byKey = await call("DELETE", "/follows/watch-all")
    expect(byKey.status).toBe(200)

    const missing = await call("DELETE", "/follows/fol_nope")
    expect(missing.status).toBe(404)
    expect(missing.json.error).toBe("follow_not_found")
  })

  it("registers session_follow / session_unfollow / session_follows over MCP and they work (follower defaults to the caller)", async () => {
    const names = (await mcp.listTools()).tools.map(t => t.name)
    expect(names).toEqual(expect.arrayContaining(["session_follow", "session_unfollow", "session_follows"]))

    const parse = (r: unknown) =>
      JSON.parse(((r as { content: Array<{ text: string }> }).content[0]!).text) as Record<string, any>

    const created = parse(
      await mcp.callTool({ name: "session_follow", arguments: { key: "mcp-k", selector: { all: true }, batchMs: 0 } }),
    )
    expect(created.ok).toBe(true)
    expect(created.created).toBe(true)
    expect(created.follow.follower).toBe(followerId) // defaulted to callerSessionId

    const listed = parse(await mcp.callTool({ name: "session_follows", arguments: {} }))
    expect(listed.follows.map((f: { key?: string }) => f.key)).toContain("mcp-k")

    const bad = (await mcp.callTool({ name: "session_follow", arguments: { selector: {} } })) as { isError?: boolean }
    expect(bad.isError).toBe(true)

    // The MCP tool and the HTTP route share one store.
    expect((await call("GET", "/follows")).json.follows.map((f: { key?: string }) => f.key)).toContain("mcp-k")

    const removed = parse(await mcp.callTool({ name: "session_unfollow", arguments: { id: "mcp-k" } }))
    expect(removed).toMatchObject({ ok: true, removed: true })
    const again = (await mcp.callTool({ name: "session_unfollow", arguments: { id: "mcp-k" } })) as { isError?: boolean }
    expect(again.isError).toBe(true)
  })
})
