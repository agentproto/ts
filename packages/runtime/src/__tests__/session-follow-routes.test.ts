/**
 * End-to-end over a real in-process daemon: `POST|GET|DELETE /follows` and the
 * `session_follow` / `session_unfollow` / `session_follows` MCP tools share one
 * store + the same validation.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import { createGateway, type GatewayHandle } from "../index.js"
import type { AgentSessionLike } from "../sessions.js"
// Exercise the actual stdio bridge forwarding path against the source runtime.
import { forwardBridgeTool } from "../../../cli/src/commands/mcp-bridge-call.js"

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
    expect(first.json.events).toEqual([
      "turn-end",
      "awaiting-input",
      "exited",
      "crashed",
      "pr-opened",
      "pr-merged",
      "task-changed",
    ])

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

  it("POST accepts urgency (default next-turn), rejects unknown values, re-POST changes it", async () => {
    const created = await call("POST", "/follows", { follower: followerId, key: "u", selector: { all: true } })
    expect(created.status).toBe(201)
    expect(created.json.urgency).toBe("next-turn")
    const updated = await call("POST", "/follows", {
      follower: followerId,
      key: "u",
      selector: { all: true },
      urgency: "fyi",
    })
    expect(updated.status).toBe(200)
    expect(updated.json.id).toBe(created.json.id)
    expect(updated.json.urgency).toBe("fyi")
    const bad = await call("POST", "/follows", { follower: followerId, selector: { all: true }, urgency: "now" })
    expect(bad.status).toBe(400)
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

  it("routes concurrent Desktop chats by per-call identity and exposes the host-wake boundary", async () => {
    const base = `${gateway.url}/mcp`
    const root = new Client({ name: "desktop-test", version: "0" })
    await root.connect(new StreamableHTTPClientTransport(new URL(base)))
    const parse = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text)
    const watched = gateway.sessions.spawnAgent({
      workspaceSlug: "default", cwd: workspace, adapterSlug: "codex",
      agentSession: {
        ...liveSession(),
        async *send() {
          yield { kind: "text-delta", text: "Finished the watched task." }
          yield { kind: "turn-end", reason: "completed" }
        },
      },
    })
    try {
      const results = await Promise.all(["chat-a", "chat-b"].map(thread_id => forwardBridgeTool(root, base, {
        name: "session_follow",
        arguments: { selector: { sessionIds: [watched.id] }, events: ["turn-end"], batchMs: 0 },
        _meta: { "x-codex-turn-metadata": JSON.stringify({ thread_id }) },
      }, "codex")))
      for (const [i, result] of results.entries()) {
        const created = parse(result)
        expect(created.ok).toBe(true)
        expect(created.follow.follower).toBe(`codex:chat-${i === 0 ? "a" : "b"}`)
        expect(created.follow.urgency).toBe("next-turn")
        expect(created.delivery).toMatchObject({ mode: "external-inbox", wakesFollower: false })
      }

      // This is the actual daemon guarantee: the next-turn digest reaches
      // the SAME chat's external inbox. A host must start the Desktop turn.
      await gateway.sessions.enqueuePrompt(watched.id, "finish")
      await vi.waitFor(() => {
        for (const id of ["codex:chat-a", "codex:chat-b"]) {
          const inbox = gateway.sessions.listInbox(id)!
          expect(inbox).toHaveLength(1)
          expect(inbox[0]).toMatchObject({ to: id, urgency: "next-turn", kind: "notice" })
          expect(inbox[0]!.text).toContain(watched.id)
        }
      })

      // The host can consume/ack with the same metadata, without storing an
      // agentproto session id. Ack one chat without consuming the other's.
      const hostRead = parse(await forwardBridgeTool(root, base, {
        name: "inbox_wait", arguments: { ack: false, timeoutMs: 1000 },
        _meta: { "x-codex-turn-metadata": { thread_id: "chat-a" } },
      }, "codex"))
      expect(hostRead.messages).toHaveLength(1)
      expect(hostRead.messages[0]).toMatchObject({
        id: gateway.sessions.listInbox("codex:chat-a")![0]!.id, urgency: "next-turn",
      })
      expect(gateway.sessions.listInbox("codex:chat-a")).toHaveLength(1)
      await forwardBridgeTool(root, base, {
        name: "inbox_ack", arguments: { ids: [hostRead.messages[0].id] },
        _meta: { "x-codex-turn-metadata": { thread_id: "chat-a" } },
      }, "codex")
      expect(gateway.sessions.listInbox("codex:chat-a")).toHaveLength(0)
      expect(gateway.sessions.listInbox("codex:chat-b")).toHaveLength(1)

      // No metadata on a later call must NOT reuse either chat's identity.
      const missing = parse(await forwardBridgeTool(root, base, {
        name: "session_follow", arguments: { selector: { all: true } },
      }, "codex"))
      expect(missing).toMatchObject({ ok: false, error: "no_follower" })
      expect(missing.message).toContain("host wake handler")

      // An explicit follower still wins even when Desktop metadata is present.
      const explicit = parse(await forwardBridgeTool(root, base, {
        name: "session_follow",
        arguments: { follower: followerId, selector: { all: true } },
        _meta: { "x-codex-turn-metadata": { thread_id: "chat-a" } },
      }, "codex"))
      expect(explicit.follow.follower).toBe(followerId)
      expect(explicit).not.toHaveProperty("delivery")
    } finally {
      await root.close()
    }
  })
})
