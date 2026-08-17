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
  readDeclaredUITools,
  callDaemonTool,
  resolveListenHost,
  sanitizeUploadName,
  resolveInboxTarget,
  UploadSizeTracker,
  MAX_UPLOAD_BYTES,
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

describe("resolveListenHost", () => {
  it("returns 127.0.0.1 when no host option is given", () => {
    expect(resolveListenHost()).toBe("127.0.0.1")
    expect(resolveListenHost(undefined)).toBe("127.0.0.1")
  })

  it("returns the caller-supplied address when given", () => {
    expect(resolveListenHost("0.0.0.0")).toBe("0.0.0.0")
    expect(resolveListenHost("::1")).toBe("::1")
  })
})

describe("readDeclaredUITools", () => {
  async function writeAppMd(dir: string, frontmatter: string) {
    await mkdir(join(dir, ".agentproto"), { recursive: true })
    await writeFile(
      join(dir, ".agentproto", "APP.md"),
      `---\n${frontmatter}---\n`,
      "utf8",
    )
  }

  it("reads a ui.tools list from APP.md frontmatter", async () => {
    const dir = await mktmp()
    await writeAppMd(
      dir,
      "schema: app/v1\nui:\n  path: .agentproto/ui/index.html\n  tools:\n    - app_run\n    - app_status\n",
    )
    expect(await readDeclaredUITools(dir)).toEqual(["app_run", "app_status"])
  })

  it("returns an empty array when ui.tools is explicitly declared as []", async () => {
    const dir = await mktmp()
    await writeAppMd(dir, "schema: app/v1\nui:\n  path: .agentproto/ui/index.html\n  tools: []\n")
    expect(await readDeclaredUITools(dir)).toEqual([])
  })

  it("returns undefined when ui.tools is not declared (absent field)", async () => {
    const dir = await mktmp()
    await writeAppMd(dir, "schema: app/v1\nui:\n  path: .agentproto/ui/index.html\n")
    expect(await readDeclaredUITools(dir)).toBeUndefined()
  })

  it("returns undefined when there is no ui section at all", async () => {
    const dir = await mktmp()
    await writeAppMd(dir, "schema: app/v1\nagents:\n  - id: a\n")
    expect(await readDeclaredUITools(dir)).toBeUndefined()
  })

  it("returns undefined for a missing APP.md", async () => {
    const dir = await mktmp()
    expect(await readDeclaredUITools(dir)).toBeUndefined()
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

  it("returns 403 for a tool not in the allowlist, without calling the daemon", async () => {
    const called: string[] = []
    const fakeClient = {
      callTool: (params: { name: string }) => {
        called.push(params.name)
        return Promise.resolve({ content: [] })
      },
    }
    const [status, body] = await callDaemonTool(
      () => Promise.resolve(fakeClient as unknown as Client),
      { name: "command_execute", args: {} },
      ["app_run", "app_status"],
    )
    expect(status).toBe(403)
    expect((body as { error: string }).error).toBe("forbidden")
    expect((body as { message: string }).message).toContain("command_execute")
    expect(called).toHaveLength(0)
  })

  it("forwards a tool that is in the allowlist", async () => {
    const called: string[] = []
    const fakeClient = {
      callTool: (params: { name: string }) => {
        called.push(params.name)
        return Promise.resolve({ content: [{ type: "text", text: "ok" }] })
      },
    }
    const [status] = await callDaemonTool(
      () => Promise.resolve(fakeClient as unknown as Client),
      { name: "app_run", args: {} },
      ["app_run", "app_status"],
    )
    expect(status).toBe(200)
    expect(called).toEqual(["app_run"])
  })

  it("allows all tools when allowedTools is undefined (ui.tools absent from APP.md)", async () => {
    const called: string[] = []
    const fakeClient = {
      callTool: (params: { name: string }) => {
        called.push(params.name)
        return Promise.resolve({ content: [{ type: "text", text: "ok" }] })
      },
    }
    const [status] = await callDaemonTool(
      () => Promise.resolve(fakeClient as unknown as Client),
      { name: "command_execute", args: {} },
      undefined,
    )
    expect(status).toBe(200)
    expect(called).toEqual(["command_execute"])
  })

  it("blocks all tools when allowedTools is an empty array", async () => {
    const called: string[] = []
    const fakeClient = {
      callTool: (params: { name: string }) => {
        called.push(params.name)
        return Promise.resolve({ content: [] })
      },
    }
    const [status, body] = await callDaemonTool(
      () => Promise.resolve(fakeClient as unknown as Client),
      { name: "app_run", args: {} },
      [],
    )
    expect(status).toBe(403)
    expect((body as { error: string }).error).toBe("forbidden")
    expect((body as { message: string }).message).toContain("(empty)")
    expect(called).toHaveLength(0)
  })
})

describe("sanitizeUploadName", () => {
  it("accepts a plain filename, preserving its extension", () => {
    expect(sanitizeUploadName("photo.png")).toBe("photo.png")
  })

  it("takes the basename of a path-y value", () => {
    expect(sanitizeUploadName("some/dir/photo.png")).toBe("photo.png")
    expect(sanitizeUploadName("some\\dir\\photo.png")).toBe("photo.png")
  })

  it("rejects traversal attempts", () => {
    expect(sanitizeUploadName("../../etc/passwd")).toBe("passwd")
    expect(sanitizeUploadName("..")).toBeNull()
    expect(sanitizeUploadName("foo..bar")).toBeNull()
  })

  it("rejects empty and null/undefined names", () => {
    expect(sanitizeUploadName("")).toBeNull()
    expect(sanitizeUploadName(null)).toBeNull()
    expect(sanitizeUploadName(undefined)).toBeNull()
    expect(sanitizeUploadName("dir/")).toBeNull()
  })

  it("rejects dotfiles", () => {
    expect(sanitizeUploadName(".env")).toBeNull()
    expect(sanitizeUploadName(".gitignore")).toBeNull()
  })
})

describe("resolveInboxTarget", () => {
  it("uses the given name when the inbox is empty", async () => {
    const dir = await mktmp()
    const { finalName, path } = await resolveInboxTarget(dir, "report.pdf")
    expect(finalName).toBe("report.pdf")
    expect(path).toBe(join(dir, "report.pdf"))
  })

  it("suffixes with -2, -3, ... before the extension on collision", async () => {
    const dir = await mktmp()
    await writeFile(join(dir, "report.pdf"), "one", "utf8")
    const first = await resolveInboxTarget(dir, "report.pdf")
    expect(first.finalName).toBe("report-2.pdf")

    await writeFile(join(dir, "report-2.pdf"), "two", "utf8")
    const second = await resolveInboxTarget(dir, "report.pdf")
    expect(second.finalName).toBe("report-3.pdf")
  })

  it("suffixes extensionless names directly", async () => {
    const dir = await mktmp()
    await writeFile(join(dir, "notes"), "one", "utf8")
    const { finalName } = await resolveInboxTarget(dir, "notes")
    expect(finalName).toBe("notes-2")
  })
})

describe("UploadSizeTracker", () => {
  it("stays under the default 200 MB limit for small uploads", () => {
    const tracker = new UploadSizeTracker()
    expect(tracker.add(1024)).toBe(false)
    expect(tracker.bytes).toBe(1024)
  })

  it("flags the chunk that pushes the running total past the limit", () => {
    const tracker = new UploadSizeTracker(100)
    expect(tracker.add(60)).toBe(false)
    expect(tracker.add(60)).toBe(true)
    expect(tracker.bytes).toBe(120)
  })

  it("defaults to MAX_UPLOAD_BYTES (200 MB)", () => {
    expect(MAX_UPLOAD_BYTES).toBe(200 * 1024 * 1024)
    const tracker = new UploadSizeTracker()
    expect(tracker.add(MAX_UPLOAD_BYTES)).toBe(false)
    expect(tracker.add(1)).toBe(true)
  })
})