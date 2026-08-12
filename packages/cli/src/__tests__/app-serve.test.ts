/**
 * Tests for `agentproto app serve` (`commands/app-serve.ts`):
 * bridge-script construction + injection, declared ui.port parsing, and the
 * `/__agentproto/tool-call` proxy contract (bad body / daemon unreachable /
 * success). Every case is hermetic — the tool-call route is exercised with a
 * mocked client (the real daemon isn't needed and isn't contacted). No live
 * bind is done here; `runAppServe`'s full flow is covered by the pieces below.
 */

import { describe, it, expect, afterEach } from "vitest"

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { IncomingMessage, ServerResponse } from "node:http"
import {
  applyCors,
  buildBridgeScript,
  injectBridge,
  readDeclaredUIPort,
  callDaemonTool,
} from "../app-serve.js"

const tmpRoots: string[] = []

async function mktmp(prefix = "app-serve-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tmpRoots.push(dir)
  return dir
}

afterEach(async () => {
  for (const p of tmpRoots) await rm(p, { recursive: true, force: true })
  tmpRoots.length = 0
})

describe("buildBridgeScript", () => {
  it("defines window.McpApp with connect returning callTool/updateModelContext/openLink/onTeardown", () => {
    const script = buildBridgeScript("/__agentproto/tool-call")
    expect(script).toContain("window.McpApp")
    expect(script).toContain("connect")
    expect(script).toContain("callTool")
    expect(script).toContain("updateModelContext")
    expect(script).toContain("openLink")
    expect(script).toContain("onTeardown")
  })

  it("callTool POSTs the tool name + args to the configured route and resolves with the body", () => {
    const script = buildBridgeScript("/__agentproto/tool-call")
    expect(script).toContain('var ROUTE = "/__agentproto/tool-call"')
    expect(script).toContain('fetch(ROUTE')
    expect(script).toContain('JSON.stringify({ name: name, args: args || {} })')
  })

  it("onTeardown registers a beforeunload cleanup (standalone tab lifecycle)", () => {
    const script = buildBridgeScript("/x")
    expect(script).toContain('addEventListener("beforeunload"')
  })
})

describe("injectBridge", () => {
  it("injects the script immediately before </head>, so it runs before app scripts", () => {
    const script = "<script>/* bridge */</script>"
    const html = "<html><head><title>t</title></head><body><script>window.McpApp.connect();</script></body></html>"
    const out = injectBridge(html, script)
    expect(out.indexOf(script)).toBeLessThan(out.indexOf("</head>"))
    expect(out.indexOf(script)).toBeLessThan(out.indexOf("window.McpApp.connect()"))
    expect(out).toContain('<title>t</title>')
  })

  it("falls back to prepending when there is no </head> or structural tag", () => {
    const script = "<script>/* bridge */</script>"
    const out = injectBridge("Panel", script)
    expect(out.startsWith(script)).toBe(true)
  })

  it("falls back to after <head> when there is a head but no closing tag", () => {
    const script = "<script>/* bridge */</script>"
    const out = injectBridge("<html><head><body>Panel</body></html>", script)
    expect(out.indexOf(script)).toBeLessThan(out.indexOf("<body>"))
  })
})

describe("applyCors", () => {
  function fakeReqRes(headers: Record<string, string> = {}) {
    const req = { headers } as unknown as IncomingMessage
    const set: Record<string, string> = {}
    const res = {
      setHeader: (name: string, value: string) => {
        set[name] = value
      },
    } as unknown as ServerResponse
    return { req, res, set }
  }

  it("allows any origin so a cross-origin viewer page can reach the tool-call bridge", () => {
    const { req, res, set } = fakeReqRes()
    applyCors(req, res)
    expect(set["Access-Control-Allow-Origin"]).toBe("*")
  })

  it("allows GET, POST, and OPTIONS", () => {
    const { req, res, set } = fakeReqRes()
    applyCors(req, res)
    expect(set["Access-Control-Allow-Methods"]).toBe("GET,POST,OPTIONS")
  })

  it("echoes the preflight's requested headers when present", () => {
    const { req, res, set } = fakeReqRes({
      "access-control-request-headers": "content-type,x-custom",
    })
    applyCors(req, res)
    expect(set["Access-Control-Allow-Headers"]).toBe("content-type,x-custom")
  })

  it("defaults Access-Control-Allow-Headers to content-type", () => {
    const { req, res, set } = fakeReqRes()
    applyCors(req, res)
    expect(set["Access-Control-Allow-Headers"]).toBe("content-type")
  })
})

describe("readDeclaredUIPort", () => {
  async function writeAppMd(dir: string, frontmatter: string) {
    await mkdir(join(dir, ".agentproto"), { recursive: true })
    await writeFile(
      join(dir, ".agentproto", "APP.md"),
      `---\n${frontmatter}---\n`,
      "utf8",
    )
  }

  it("reads a valid ui.port from APP.md frontmatter", async () => {
    const dir = await mktmp()
    await writeAppMd(dir, "schema: app/v1\nui:\n  path: .agentproto/ui/index.html\n  port: 8123\n")
    expect(await readDeclaredUIPort(dir)).toBe(8123)
  })

  it("returns undefined when no ui.port is declared", async () => {
    const dir = await mktmp()
    await writeAppMd(dir, "schema: app/v1\nagents:\n  - id: a\n")
    expect(await readDeclaredUIPort(dir)).toBeUndefined()
  })

  it("returns undefined for a missing APP.md", async () => {
    const dir = await mktmp()
    expect(await readDeclaredUIPort(dir)).toBeUndefined()
  })

  it("returns undefined for an invalid port value (string / out of range)", async () => {
    const strDir = await mktmp()
    await writeAppMd(strDir, "schema: app/v1\nui:\n  port: \"8123\"\n")
    expect(await readDeclaredUIPort(strDir)).toBeUndefined()

    const rangeDir = await mktmp()
    await writeAppMd(rangeDir, "schema: app/v1\nui:\n  port: 99999\n")
    expect(await readDeclaredUIPort(rangeDir)).toBeUndefined()
  })
})

describe("callDaemonTool", () => {
  it("returns 400 for a malformed body", async () => {
    const [status, body] = await callDaemonTool(
      async () => new Client({ name: "t", version: "0" }, { capabilities: {} }),
      { name: 42 },
    )
    expect(status).toBe(400)
    expect((body as { error: string }).error).toBe("bad_request")
  })

  it("returns 502 with a friendly message when the daemon is unreachable", async () => {
    const [status, body] = await callDaemonTool(
      () => Promise.reject(new Error("connect ECONNREFUSED")),
      { name: "command_execute" },
    )
    expect(status).toBe(502)
    expect((body as { message: string }).message).toContain("Start the daemon first")
  })

  it("forwards the call through the client and returns the MCP result envelope", async () => {
    const called: { name: string; args: unknown }[] = []
    const fakeClient = {
      callTool: (params: { name: string; arguments?: unknown }) => {
        called.push({ name: params.name, args: params.arguments })
        return Promise.resolve({ content: [{ type: "text", text: "ok" }] })
      },
    }
    const [status, body] = await callDaemonTool(
      () => Promise.resolve(fakeClient as unknown as Client),
      { name: "read_file", args: { path: "/tmp/x" } },
    )
    expect(status).toBe(200)
    expect(called).toEqual([{ name: "read_file", args: { path: "/tmp/x" } }])
    expect(body).toEqual({ content: [{ type: "text", text: "ok" }] })
  })

  it("normalizes non-object args to {} and still forwards", async () => {
    const called: unknown[] = []
    const fakeClient = {
      callTool: (params: { name: string; arguments?: unknown }) => {
        called.push(params.arguments)
        return Promise.resolve({ content: [] })
      },
    }
    await callDaemonTool(
      () => Promise.resolve(fakeClient as unknown as Client),
      { name: "do", args: "not-an-object" },
    )
    expect(called).toEqual([{}])
  })
})