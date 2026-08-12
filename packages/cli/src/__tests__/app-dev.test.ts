/**
 * Tests for `agentproto app dev` (`../app-dev.ts`): arg validation (missing
 * ui/ dev project, bad --port), the bridge-only HTTP server's routing/CORS
 * contract (tested directly against `bindBridgeServer` with a fake daemon
 * client — no live daemon), and a full `runAppDev` run against a fixture
 * `ui/` dev script that exits immediately, verifying the bridge URL is
 * reported and threaded into the child's env. Every bound HTTP server is
 * closed before its test returns, so no port outlives its test.
 */

import { describe, it, expect, afterEach, vi } from "vitest"

import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { runAppDev, bindBridgeServer } from "../app-dev.js"
import { TOOL_CALL_PATH } from "../app-serve.js"

const tmpRoots: string[] = []

afterEach(async () => {
  for (const p of tmpRoots) await rm(p, { recursive: true, force: true })
  tmpRoots.length = 0
  vi.restoreAllMocks()
})

async function mktmp(prefix = "app-dev-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tmpRoots.push(dir)
  return dir
}

function captureStdout(): string[] {
  const writes: string[] = []
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  })
  return writes
}

function captureStderr(): string[] {
  const writes: string[] = []
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  })
  return writes
}

async function writeUiPackage(
  appDir: string,
  scripts: Record<string, string>,
): Promise<void> {
  await mkdir(join(appDir, "ui"), { recursive: true })
  await writeFile(
    join(appDir, "ui", "package.json"),
    JSON.stringify({ name: "ui", scripts }),
    "utf8",
  )
}

// ── bindBridgeServer: HTTP plumbing, no live daemon ────────────────────────

describe("bindBridgeServer", () => {
  it("forwards POST /__agentproto/tool-call through the client and sets CORS headers", async () => {
    const fakeClient = {
      callTool: (params: { name: string; arguments?: unknown }) =>
        Promise.resolve({ content: [{ type: "text", text: `ran ${params.name}` }] }),
    }
    const getClient = () => Promise.resolve(fakeClient as unknown as Client)
    const bridge = await bindBridgeServer(0, getClient)
    try {
      const res = await fetch(`http://127.0.0.1:${bridge.port}${TOOL_CALL_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "some_tool", args: {} }),
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("access-control-allow-origin")).toBe("*")
      const body = await res.json()
      expect(body).toEqual({ content: [{ type: "text", text: "ran some_tool" }] })
    } finally {
      await bridge.close()
    }
  })

  it("answers OPTIONS preflight with CORS headers and 204", async () => {
    const getClient = () => Promise.reject(new Error("unused"))
    const bridge = await bindBridgeServer(0, getClient)
    try {
      const res = await fetch(`http://127.0.0.1:${bridge.port}${TOOL_CALL_PATH}`, {
        method: "OPTIONS",
      })
      expect(res.status).toBe(204)
      expect(res.headers.get("access-control-allow-origin")).toBe("*")
      expect(res.headers.get("access-control-allow-methods")).toContain("POST")
    } finally {
      await bridge.close()
    }
  })

  it("404s any other path", async () => {
    const getClient = () => Promise.reject(new Error("unused"))
    const bridge = await bindBridgeServer(0, getClient)
    try {
      const res = await fetch(`http://127.0.0.1:${bridge.port}/nope`)
      expect(res.status).toBe(404)
    } finally {
      await bridge.close()
    }
  })
})

// ── runAppDev: arg validation + full spawn/teardown flow ───────────────────

describe("runAppDev", () => {
  it("returns 2 when <appDir> is omitted", async () => {
    expect(await runAppDev([])).toBe(2)
  })

  it("returns 2 when appDir has no ui/package.json", async () => {
    const appDir = await mktmp()
    const stderr = captureStderr()
    expect(await runAppDev([appDir])).toBe(2)
    expect(stderr.join("")).toContain("app serve")
  })

  it("returns 2 when ui/package.json has no scripts.dev", async () => {
    const appDir = await mktmp()
    await writeUiPackage(appDir, { build: "vite build" })
    const stderr = captureStderr()
    expect(await runAppDev([appDir])).toBe(2)
    expect(stderr.join("")).toContain("scripts.dev")
  })

  it("returns 2 for an out-of-range --port", async () => {
    const appDir = await mktmp()
    await writeUiPackage(appDir, { dev: "vite" })
    const stderr = captureStderr()
    expect(await runAppDev([appDir, "--port", "99999"])).toBe(2)
    expect(stderr.join("")).toContain("invalid --port")
  })

  it("starts the bridge, spawns the ui dev script with AGENTPROTO_BRIDGE_URL, and exits with its code", async () => {
    const appDir = await mktmp()
    const marker = join(appDir, "bridge-url-seen.txt")
    await writeUiPackage(appDir, {
      dev:
        `node -e "require('fs').writeFileSync('${marker}', process.env.AGENTPROTO_BRIDGE_URL || ''); process.exit(5)"`,
    })

    const writes = captureStdout()
    const code = await runAppDev([appDir, "--json"])
    expect(code).toBe(5)

    const printed = JSON.parse(writes.join(""))
    expect(printed.appDir).toBe(appDir)
    expect(printed.bridgeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const seen = await readFile(marker, "utf8")
    expect(seen).toBe(printed.bridgeUrl)
  })
})
