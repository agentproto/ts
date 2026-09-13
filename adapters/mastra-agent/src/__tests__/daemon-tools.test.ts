/**
 * WP-5 — the daemon sub-agent-spawning Mastra tools (`agent_start`,
 * `agent_prompt`, `agent_output`, `session_list`): happy path against an
 * injected fake fetch (route, bearer token, parentSessionId pass-through
 * verified through the real `DaemonClient`), and the fail-fast behavior when
 * no daemon is discoverable.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DaemonClient } from "../daemon-client.js"
import { makeDaemonTools } from "../daemon-tools.js"

/** `createTool`'s `execute` is `(inputData, context) => Promise<...>` — the
 *  parsed input is the FIRST positional arg, not wrapped in `{context}`
 *  (matches `workspace-tools.ts`'s own `execute: guard(id, (input) => ...)`
 *  functions, which take a single positional arg and ignore the second). */
function callTool(tool: { execute?: unknown }, input: unknown): Promise<unknown> {
  return (tool.execute as (input: unknown, context: unknown) => Promise<unknown>)(input, {})
}

const tmpDirs: string[] = []
async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mastra-agent-daemon-tools-"))
  tmpDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

interface FakeCall {
  url: URL
  method: string
  headers: Record<string, string>
  body: unknown
}

function fakeFetchReturning(status: number, body: unknown): { fetchImpl: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    calls.push({
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  return { fetchImpl, calls }
}

describe("makeDaemonTools — ids", () => {
  it("builds exactly the four daemon verb tools, matching tool-categories.ts's CATEGORY_BY_TOOL", () => {
    const client = new DaemonClient({ env: {}, endpoint: { url: "http://daemon.test" } })
    const tools = makeDaemonTools({ client })
    expect(Object.keys(tools).sort()).toEqual(["agent_output", "agent_prompt", "agent_start", "session_list"])
  })
})

describe("makeDaemonTools — happy path", () => {
  it("agent_start calls POST /sessions/agent with bearer token + parentSessionId", async () => {
    const { fetchImpl, calls } = fakeFetchReturning(200, { id: "child-1", kind: "agent-cli" })
    const client = new DaemonClient({
      env: { AGENTPROTO_SESSION_ID: "parent-1" },
      endpoint: { url: "http://daemon.test", token: "tok-123" },
      fetchImpl,
    })
    const tools = makeDaemonTools({ client })

    const result = await callTool(tools.agent_start!, { adapter: "claude-code", prompt: "do the thing" })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("POST")
    expect(calls[0]!.url.pathname).toBe("/sessions/agent")
    expect(calls[0]!.headers.authorization).toBe("Bearer tok-123")
    expect(calls[0]!.body).toEqual({ adapter: "claude-code", prompt: "do the thing", parentSessionId: "parent-1" })
    expect(result).toEqual({ id: "child-1", kind: "agent-cli" })
  })

  it("agent_prompt calls POST /sessions/:id/prompt", async () => {
    const { fetchImpl, calls } = fakeFetchReturning(200, { ok: true, id: "sess-1" })
    const client = new DaemonClient({ env: {}, endpoint: { url: "http://daemon.test", token: "tok" }, fetchImpl })
    const tools = makeDaemonTools({ client })

    await callTool(tools.agent_prompt!, { sessionId: "sess-1", text: "hello" })

    expect(calls[0]!.url.pathname).toBe("/sessions/sess-1/prompt")
    expect(calls[0]!.headers.authorization).toBe("Bearer tok")
    expect(calls[0]!.body).toEqual({ prompt: "hello" })
  })

  it("agent_output calls GET /sessions/:id/export and tails large content", async () => {
    const bigContent = "x".repeat(5000)
    const { fetchImpl } = fakeFetchReturning(200, { adapter: "hermes", content: bigContent })
    const client = new DaemonClient({ env: {}, endpoint: { url: "http://daemon.test" }, fetchImpl })
    const tools = makeDaemonTools({ client })

    const result = (await callTool(tools.agent_output!, { sessionId: "sess-2" })) as { content: string }

    expect(result.content.length).toBe(4000)
    expect(result.content).toBe(bigContent.slice(-4000))
  })

  it("session_list calls GET /sessions", async () => {
    const { fetchImpl, calls } = fakeFetchReturning(200, { sessions: [{ id: "a" }, { id: "b" }] })
    const client = new DaemonClient({ env: {}, endpoint: { url: "http://daemon.test" }, fetchImpl })
    const tools = makeDaemonTools({ client })

    const result = await callTool(tools.session_list!, {})
    expect(calls[0]!.url.pathname).toBe("/sessions")
    expect(result).toEqual({ sessions: [{ id: "a" }, { id: "b" }] })
  })
})

describe("makeDaemonTools — no daemon discoverable", () => {
  it("fails fast with a clear message instead of hanging, without ever calling fetch", async () => {
    const cwd = await makeTmpDir()
    const homeDir = await makeTmpDir()
    let fetchCalled = false
    const fetchImpl = (async () => {
      fetchCalled = true
      throw new Error("should not be called")
    }) as typeof fetch

    const client = new DaemonClient({ cwd, homeDir, env: {}, fetchImpl })
    const tools = makeDaemonTools({ client })

    await expect(callTool(tools.agent_start!, { adapter: "claude-code" })).rejects.toThrow(
      /no agentproto daemon found/,
    )
    expect(fetchCalled).toBe(false)
  })
})
