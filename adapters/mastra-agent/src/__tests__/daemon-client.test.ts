/**
 * WP-5 — `discoverDaemonEndpoint`'s discovery order (env > cwd runtime.json >
 * home runtime.json > central registry, newest-mtime-first, dead pids never
 * trusted) and `DaemonClient`'s request shaping (route, bearer token,
 * `parentSessionId` pass-through). Every filesystem path discovery touches is
 * injected (`cwd`/`homeDir`/`registryDir`) so these tests never read a real
 * developer machine's `~/.agentproto`.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  DaemonClient,
  DaemonHttpError,
  DaemonNotFoundError,
  discoverDaemonEndpoint,
} from "../daemon-client.js"

const tmpDirs: string[] = []
async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mastra-agent-daemon-client-"))
  tmpDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function writeRuntimeJson(path: string, meta: Record<string, unknown>): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, JSON.stringify(meta), "utf8")
}

const alwaysAlive = () => true
const alwaysDead = () => false

describe("discoverDaemonEndpoint", () => {
  it("env override wins over any on-disk runtime.json", async () => {
    const cwd = await makeTmpDir()
    const homeDir = await makeTmpDir()
    await writeRuntimeJson(join(cwd, ".agentproto", "runtime.json"), {
      port: 1111,
      bind: "127.0.0.1",
      pid: 1,
      token: "cwd-token",
    })

    const endpoint = await discoverDaemonEndpoint({
      cwd,
      homeDir,
      isPidAlive: alwaysAlive,
      env: { AGENTPROTO_DAEMON_URL: "http://example.test:9999/", AGENTPROTO_DAEMON_TOKEN: "env-token" },
    })

    expect(endpoint).toEqual({ url: "http://example.test:9999", token: "env-token" })
  })

  it("cwd runtime.json wins over home runtime.json and the central registry", async () => {
    const cwd = await makeTmpDir()
    const homeDir = await makeTmpDir()
    await writeRuntimeJson(join(cwd, ".agentproto", "runtime.json"), {
      port: 2222,
      bind: "127.0.0.1",
      pid: 1,
      token: "cwd-token",
    })
    await writeRuntimeJson(join(homeDir, ".agentproto", "runtime.json"), {
      port: 3333,
      bind: "127.0.0.1",
      pid: 1,
      token: "home-token",
    })

    const endpoint = await discoverDaemonEndpoint({ cwd, homeDir, isPidAlive: alwaysAlive, env: {} })
    expect(endpoint).toEqual({
      url: "http://127.0.0.1:2222",
      token: "cwd-token",
      sourcePath: join(cwd, ".agentproto", "runtime.json"),
    })
  })

  it("a dead-pid runtime.json is ignored, not trusted", async () => {
    const cwd = await makeTmpDir()
    const homeDir = await makeTmpDir()
    await writeRuntimeJson(join(cwd, ".agentproto", "runtime.json"), {
      port: 4444,
      bind: "127.0.0.1",
      pid: 999,
      token: "dead-token",
    })

    const endpoint = await discoverDaemonEndpoint({ cwd, homeDir, isPidAlive: alwaysDead, env: {} })
    expect(endpoint).toBeUndefined()
  })

  it("central registry: a dead-pid entry is skipped in favor of a live one, newest-mtime-first among live entries", async () => {
    const cwd = await makeTmpDir()
    const homeDir = await makeTmpDir()
    const registryDir = join(homeDir, ".agentproto", "daemons")
    await mkdir(registryDir, { recursive: true })

    // Written first (older mtime) but dead — must be skipped even though
    // nothing younger exists yet at write time.
    await writeFile(
      join(registryDir, "10001.json"),
      JSON.stringify({ port: 10001, bind: "127.0.0.1", pid: 1, token: "dead-registry-token" }),
      "utf8",
    )
    // Written second (newer mtime) and live — should win.
    await writeFile(
      join(registryDir, "10002.json"),
      JSON.stringify({ port: 10002, bind: "127.0.0.1", pid: 2, token: "live-registry-token" }),
      "utf8",
    )

    const isPidAlive = (pid: number) => pid === 2

    const endpoint = await discoverDaemonEndpoint({ cwd, homeDir, isPidAlive, env: {} })
    expect(endpoint).toEqual({
      url: "http://127.0.0.1:10002",
      token: "live-registry-token",
      sourcePath: join(registryDir, "10002.json"),
    })
  })

  it("returns undefined when nothing is discoverable", async () => {
    const cwd = await makeTmpDir()
    const homeDir = await makeTmpDir()
    const endpoint = await discoverDaemonEndpoint({ cwd, homeDir, isPidAlive: alwaysAlive, env: {} })
    expect(endpoint).toBeUndefined()
  })
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

describe("DaemonClient request shaping", () => {
  it("startAgent POSTs /sessions/agent with the bearer token and parentSessionId from AGENTPROTO_SESSION_ID", async () => {
    const { fetchImpl, calls } = fakeFetchReturning(200, { id: "child-1" })
    const client = new DaemonClient({
      env: { AGENTPROTO_SESSION_ID: "parent-1" },
      endpoint: { url: "http://daemon.test", token: "secret-token" },
      fetchImpl,
    })

    const result = await client.startAgent({ adapter: "claude-code", cwd: "/tmp/work", prompt: "hi" })

    expect(result).toEqual({ id: "child-1" })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("POST")
    expect(calls[0]!.url.pathname).toBe("/sessions/agent")
    expect(calls[0]!.headers.authorization).toBe("Bearer secret-token")
    expect(calls[0]!.body).toEqual({
      adapter: "claude-code",
      cwd: "/tmp/work",
      prompt: "hi",
      parentSessionId: "parent-1",
    })
  })

  it("startAgent omits parentSessionId when AGENTPROTO_SESSION_ID is unset", async () => {
    const { fetchImpl, calls } = fakeFetchReturning(200, { id: "child-2" })
    const client = new DaemonClient({
      env: {},
      endpoint: { url: "http://daemon.test" },
      fetchImpl,
    })

    await client.startAgent({ adapter: "hermes" })
    expect(calls[0]!.body).toEqual({ adapter: "hermes" })
    expect(calls[0]!.headers.authorization).toBeUndefined()
  })

  it("promptAgent POSTs /sessions/:id/prompt with interrupt + wait=false query", async () => {
    const { fetchImpl, calls } = fakeFetchReturning(202, { ok: true, queued: true })
    const client = new DaemonClient({
      env: {},
      endpoint: { url: "http://daemon.test", token: "tok" },
      fetchImpl,
    })

    await client.promptAgent("sess-1", "redirect now", { interrupt: true, wait: false })
    expect(calls[0]!.url.pathname).toBe("/sessions/sess-1/prompt")
    expect(calls[0]!.url.searchParams.get("wait")).toBe("false")
    expect(calls[0]!.body).toEqual({ prompt: "redirect now", interrupt: true })
  })

  it("listSessions GETs /sessions with query params", async () => {
    const { fetchImpl, calls } = fakeFetchReturning(200, { sessions: [] })
    const client = new DaemonClient({ env: {}, endpoint: { url: "http://daemon.test" }, fetchImpl })

    await client.listSessions({ includeArchived: true, kind: "agent-cli" })
    expect(calls[0]!.url.pathname).toBe("/sessions")
    expect(calls[0]!.url.searchParams.get("includeArchived")).toBe("true")
    expect(calls[0]!.url.searchParams.get("kind")).toBe("agent-cli")
  })

  it("readOutput GETs /sessions/:id/export defaulting format=json", async () => {
    const { fetchImpl, calls } = fakeFetchReturning(200, { adapter: "hermes", content: "hi" })
    const client = new DaemonClient({ env: {}, endpoint: { url: "http://daemon.test" }, fetchImpl })

    const result = await client.readOutput("sess-2")
    expect(calls[0]!.url.pathname).toBe("/sessions/sess-2/export")
    expect(calls[0]!.url.searchParams.get("format")).toBe("json")
    expect(result).toEqual({ adapter: "hermes", content: "hi" })
  })

  it("pollEvents GETs /sessions/:id/events with since/limit and filters by types client-side", async () => {
    const { fetchImpl, calls } = fakeFetchReturning(200, {
      sessionId: "sess-3",
      events: [
        { seq: 1, kind: "text-delta", text: "a" },
        { seq: 2, kind: "turn-end", reason: "stop" },
        { seq: 3, kind: "error", error: "boom" },
      ],
      nextSeq: 3,
      complete: true,
    })
    const client = new DaemonClient({ env: {}, endpoint: { url: "http://daemon.test" }, fetchImpl })

    const result = await client.pollEvents("sess-3", { since: 0, limit: 50, types: ["turn-end", "error"] })
    expect(calls[0]!.url.pathname).toBe("/sessions/sess-3/events")
    expect(calls[0]!.url.searchParams.get("since")).toBe("0")
    expect(calls[0]!.url.searchParams.get("limit")).toBe("50")
    expect(result.events.map((e) => e.kind)).toEqual(["turn-end", "error"])
    expect(result.nextSeq).toBe(3)
  })

  it("throws DaemonHttpError with status + body snippet on a non-2xx response", async () => {
    const { fetchImpl } = fakeFetchReturning(404, { error: "no_session" })
    const client = new DaemonClient({ env: {}, endpoint: { url: "http://daemon.test" }, fetchImpl })

    await expect(client.readOutput("missing")).rejects.toMatchObject({
      status: 404,
    })
    await expect(client.readOutput("missing")).rejects.toBeInstanceOf(DaemonHttpError)
  })

  it("throws DaemonNotFoundError fast when no daemon is discoverable, without ever calling fetch", async () => {
    const cwd = await makeTmpDir()
    const homeDir = await makeTmpDir()
    let fetchCalled = false
    const fetchImpl = (async () => {
      fetchCalled = true
      throw new Error("should not be called")
    }) as typeof fetch

    const client = new DaemonClient({ cwd, homeDir, env: {}, fetchImpl })
    await expect(client.listSessions()).rejects.toBeInstanceOf(DaemonNotFoundError)
    expect(fetchCalled).toBe(false)
  })
})
