/**
 * WP3 — sandbox app-serve tests: the pure helpers of
 * `sandbox-app-serve.ts`, the orchestration against a FAKE `BoxToolClient`
 * (no network, no sandbox), and the HTTP body mapper's `appServe` field
 * parsing (`buildSpawnSessionHttpArgs`).
 */

import { describe, expect, it } from "vitest"

import {
  buildServeLaunchScript,
  mergeAllowlistForAppServe,
  parseJsonRecordText,
  parseToolJson,
  pollServeReady,
  startSandboxAppServe,
  BOX_ALLOWLIST_REL,
  type BoxToolClient,
  type SandboxServeHost,
  type ToolTextResult,
} from "../sandbox-app-serve.js"
import { buildSpawnSessionHttpArgs } from "../http-server.js"

function textResult(value: object): ToolTextResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] }
}

interface FakeCall {
  name: string
  args: Record<string, string | number | string[]>
}

/** Fake box daemon client — records every call, answers per tool name. */
function makeFakeClient(
  respond: (name: string, args: Record<string, string | number | string[]>) => ToolTextResult,
): BoxToolClient & { calls: FakeCall[] } {
  const calls: FakeCall[] = []
  return {
    calls,
    async callTool(name, args) {
      calls.push({ name, args })
      return respond(name, args)
    },
    async close() {},
  }
}

describe("buildServeLaunchScript", () => {
  it("builds a detached (nohup backgrounded) serve command bound to 0.0.0.0", () => {
    const script = buildServeLaunchScript("/home/user/apps/my-app", 4321)
    expect(script).toContain("nohup agentproto app serve '/home/user/apps/my-app'")
    expect(script).toContain("--host 0.0.0.0")
    expect(script).toContain("--port 4321")
    // Backgrounded: the launcher must not block the command_execute RPC.
    expect(script).toContain("& echo $!")
  })

  it("refuses a dir containing a single quote (shell-quoting injection)", () => {
    expect(() => buildServeLaunchScript("/home/user/apps/o'brien", 3210)).toThrow(/single quote/)
  })
})

describe("mergeAllowlistForAppServe", () => {
  it("seeds a minimal allowlist when the file is absent", () => {
    const merged = JSON.parse(mergeAllowlistForAppServe(null))
    expect(merged.version).toBe(1)
    expect(merged.commands).toEqual(["sh", "agentproto"])
  })

  it("preserves existing entries (plain strings and argv-constrained objects)", () => {
    const existing = JSON.stringify({
      version: 1,
      commands: ["git", { command: "gh", args: ["pr", "create"] }],
    })
    const merged = JSON.parse(mergeAllowlistForAppServe(existing))
    expect(merged.commands).toContain("git")
    expect(merged.commands).toContainEqual({ command: "gh", args: ["pr", "create"] })
    for (const required of ["sh", "agentproto"]) {
      expect(merged.commands).toContain(required)
    }
    expect(merged.commands).toHaveLength(4)
  })

  it("is idempotent — no duplicate entries on re-merge", () => {
    const once = mergeAllowlistForAppServe(null)
    const twice = JSON.parse(mergeAllowlistForAppServe(once))
    expect(twice.commands).toEqual(["sh", "agentproto"])
  })
})

describe("parseJsonRecordText / parseToolJson", () => {
  it("parses object payloads and rejects non-objects", () => {
    expect(parseJsonRecordText('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonRecordText("[1,2]")).toBeUndefined()
    expect(parseJsonRecordText("")).toBeUndefined()
    expect(parseToolJson({ content: [] })).toBeUndefined()
    expect(parseToolJson(textResult({ ok: true }))).toEqual({ ok: true })
  })
})

describe("pollServeReady", () => {
  it("returns true on the first passing probe", async () => {
    const ready = await pollServeReady("https://box.example", {
      probe: async () => true,
      intervalMs: 1,
    })
    expect(ready).toBe(true)
  })

  it("returns false once the window elapses without a pass", async () => {
    const ready = await pollServeReady("https://box.example", {
      probe: async () => false,
      timeoutMs: 10,
      intervalMs: 1,
    })
    expect(ready).toBe(false)
  })
})

describe("startSandboxAppServe", () => {
  const DIR = "/home/user/apps/job-kit"
  const PUBLIC_URL = "https://3210-sbx.example.e2b.app"

  function fakeHost(overrides?: Partial<SandboxServeHost>): SandboxServeHost {
    return {
      mcpUrl: "https://sbx.example/mcp",
      ports: { 3210: PUBLIC_URL },
      ...overrides,
    }
  }

  function makeServingClient(): BoxToolClient & { calls: FakeCall[] } {
    return makeFakeClient(name => {
      if (name === "app_install") return textResult({ appId: "acme/job-kit", dir: DIR })
      if (name === "command_execute") {
        return textResult({ exitCode: 0, signal: null, stdout: "1234\n", stderr: "" })
      }
      return textResult({ ok: true })
    })
  }

  it("installs the app, seeds the allowlist, launches the detached server, and returns the URL", async () => {
    const client = makeServingClient()
    const result = await startSandboxAppServe(fakeHost(), { dir: DIR, port: 3210 }, {
      probe: async () => true,
      connect: async () => client,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.appServe).toEqual({
      appId: "acme/job-kit",
      dir: DIR,
      port: 3210,
      url: PUBLIC_URL,
      ready: true,
    })

    // 1. The app was installed from the in-box dir.
    const install = client.calls.find(c => c.name === "app_install")
    expect(install?.args).toEqual({ dir: DIR })

    // 2. The allowlist was seeded with the launcher's basenames.
    const write = client.calls.find(c => c.name === "file_write")
    expect(write?.args.path).toBe(BOX_ALLOWLIST_REL)
    const seeded = JSON.parse(String(write?.args.content))
    expect(seeded.commands).toEqual(expect.arrayContaining(["sh", "agentproto"]))

    // 3. The server was launched detached via sh -c on the requested port.
    const execute = client.calls.find(c => c.name === "command_execute")
    expect(execute?.args.command).toBe("sh")
    const argv = execute?.args.args
    const script = Array.isArray(argv) ? argv[1] : undefined
    expect(script).toEqual(expect.stringContaining("nohup agentproto app serve '/home/user/apps/job-kit'"))
    expect(script).toContain("--port 3210")
  })

  it("falls back to expose(port) when the ports map has no entry", async () => {
    const client = makeServingClient()
    let exposedWith: number | undefined
    const host = fakeHost({
      ports: undefined,
      expose: async (port: number) => {
        exposedWith = port
        return { url: "https://lazy.example" }
      },
    })
    const result = await startSandboxAppServe(host, { dir: DIR, port: 4567 }, {
      probe: async () => true,
      connect: async () => client,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(exposedWith).toBe(4567)
    expect(result.appServe.url).toBe("https://lazy.example")
    expect(result.appServe.port).toBe(4567)
  })

  it("reports ready:false (still ok) when the server does not answer within the window", async () => {
    const client = makeServingClient()
    const result = await startSandboxAppServe(fakeHost(), { dir: DIR, port: 3210 }, {
      probe: async () => false,
      timeoutMs: 20,
      intervalMs: 1,
      connect: async () => client,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.appServe.ready).toBe(false)
    expect(result.appServe.url).toBe(PUBLIC_URL)
  })

  it("fails cleanly when the provider offers neither ports nor expose", async () => {
    const result = await startSandboxAppServe(
      { mcpUrl: "https://sbx.example/mcp" },
      { dir: DIR, port: 3210 },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain("no public URL")
  })

  it("fails cleanly when the box's app_install errors", async () => {
    const client = makeFakeClient(() => {
      throw new Error('box tool "app_install" failed: not an agentproto app')
    })
    const result = await startSandboxAppServe(fakeHost(), { dir: DIR, port: 3210 }, {
      connect: async () => client,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain("not an agentproto app")
  })

  it("fails cleanly when the launcher command exits non-zero", async () => {
    const client = makeFakeClient(name => {
      if (name === "app_install") return textResult({ appId: "acme/job-kit" })
      if (name === "command_execute") {
        return textResult({ exitCode: 127, signal: null, stdout: "", stderr: "sh: agentproto: not found" })
      }
      return textResult({ ok: true })
    })
    const result = await startSandboxAppServe(fakeHost(), { dir: DIR, port: 3210 }, {
      connect: async () => client,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain("agentproto: not found")
  })

  it("fails cleanly when app_install returns no appId", async () => {
    const client = makeFakeClient(() => textResult({ unexpected: true }))
    const result = await startSandboxAppServe(fakeHost(), { dir: DIR, port: 3210 }, {
      connect: async () => client,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain("no appId")
  })
})

describe("buildSpawnSessionHttpArgs — appServe field", () => {
  it("forwards an object appServe with an explicit port", () => {
    const args = buildSpawnSessionHttpArgs(
      { adapter: "mastra-agent", appServe: { dir: "/home/user/apps/a", port: 4000 } },
      "mastra-agent",
    )
    expect(args.appServe).toEqual({ dir: "/home/user/apps/a", port: 4000 })
  })

  it("tolerates a JSON-stringified appServe and defaults the port", () => {
    const args = buildSpawnSessionHttpArgs(
      { adapter: "mastra-agent", appServe: JSON.stringify({ dir: "/home/user/apps/b" }) },
      "mastra-agent",
    )
    expect(args.appServe).toEqual({ dir: "/home/user/apps/b", port: 3210 })
  })

  it("drops an appServe without a dir and an out-of-range port", () => {
    const noDir = buildSpawnSessionHttpArgs(
      { adapter: "mastra-agent", appServe: { port: 4000 } },
      "mastra-agent",
    )
    expect(noDir.appServe).toBeUndefined()
    const badPort = buildSpawnSessionHttpArgs(
      { adapter: "mastra-agent", appServe: { dir: "/x", port: 70000 } },
      "mastra-agent",
    )
    expect(badPort.appServe).toBeUndefined()
  })
})
