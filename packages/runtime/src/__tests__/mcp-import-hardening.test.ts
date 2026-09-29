/**
 * P0 hardening of imported-MCP connections: 0600 file mode, `${VAR}` header
 * expansion on the proxy path, 401/403 → drop + reconnect on both registries,
 * and one shared resolver for the proxy and the apps host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, stat, writeFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const openMock = vi.hoisted(() => vi.fn())
vi.mock("../mcp-client-pool.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../mcp-client-pool.js")>()
  return { ...actual, openMcpClient: openMock }
})

import { McpClientPool } from "../mcp-client-pool.js"
import { McpProxyRegistry } from "../mcp-proxy.js"
import { resolveMcpServer } from "../mcp-app-resolve.js"
import { resolveImportConnection } from "../mcp-import-resolve.js"
import { saveImportedMcps, type ImportedMcpEntry } from "../mcp-imports.js"

const snapshot = {
  id: "claude-code:global:up",
  source: "claude-code" as const,
  scope: "global",
  name: "up",
  type: "http" as const,
  url: "https://up.example/mcp",
  headers: { Authorization: "Bearer ${UP_TOKEN}" },
}
const entry: ImportedMcpEntry = {
  id: snapshot.id,
  alias: "up",
  addedAt: "2026-01-01T00:00:00.000Z",
  snapshot,
}

function fakeClient(callTool: () => Promise<unknown>) {
  return {
    listTools: async () => ({ tools: [{ name: "t" }] }),
    callTool,
    close: async () => {},
  }
}

let home: string
let prevHome: string | undefined
const importsPath = () => join(home, ".agentproto", "imported-mcps.json")

beforeEach(async () => {
  openMock.mockReset()
  home = await mkdtemp(join(tmpdir(), "mcp-hardening-"))
  await mkdir(join(home, ".agentproto"), { recursive: true })
  prevHome = process.env.HOME
  process.env.HOME = home
})
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
})

describe("saveImportedMcps file mode", () => {
  it("writes imported-mcps.json with mode 0600", async () => {
    await saveImportedMcps({ version: 1, imports: [entry] }, importsPath())
    expect((await stat(importsPath())).mode & 0o777).toBe(0o600)
  })
  it("tightens a pre-existing 0644 file on rewrite", async () => {
    await writeFile(importsPath(), "{}")
    await chmod(importsPath(), 0o644)
    await saveImportedMcps({ version: 1, imports: [entry] }, importsPath())
    expect((await stat(importsPath())).mode & 0o777).toBe(0o600)
  })
})

describe("McpProxyRegistry", () => {
  it("opens upstream with expandHeaders: true", async () => {
    await saveImportedMcps({ version: 1, imports: [entry] }, importsPath())
    openMock.mockResolvedValue(fakeClient(async () => ({ ok: 1 })))
    const reg = new McpProxyRegistry()
    await reg.callTool("up", "t", {})
    expect(openMock).toHaveBeenCalledTimes(1)
    expect(openMock.mock.calls[0]![1]).toMatchObject({ expandHeaders: true })
  })

  it.each(["401 Unauthorized", "HTTP 403", "Forbidden"])(
    "resets the client when callTool fails with %s, then reconnects",
    async msg => {
      await saveImportedMcps({ version: 1, imports: [entry] }, importsPath())
      openMock
        .mockResolvedValueOnce(
          fakeClient(async () => {
            throw new Error(msg)
          })
        )
        .mockResolvedValueOnce(fakeClient(async () => ({ ok: 1 })))
      const reg = new McpProxyRegistry()
      const first = await reg.callTool("up", "t", {})
      expect(first.ok).toBe(false)
      const second = await reg.callTool("up", "t", {})
      expect(second.ok).toBe(true)
      expect(openMock).toHaveBeenCalledTimes(2)
    }
  )

  it("does not reset on an unrelated tool error", async () => {
    await saveImportedMcps({ version: 1, imports: [entry] }, importsPath())
    openMock.mockResolvedValue(
      fakeClient(async () => {
        throw new Error("bad arguments")
      })
    )
    const reg = new McpProxyRegistry()
    await reg.callTool("up", "t", {})
    await reg.callTool("up", "t", {})
    expect(openMock).toHaveBeenCalledTimes(1)
  })
})

describe("McpClientPool", () => {
  it("drops the pooled client on 401 so the next call reconnects", async () => {
    let n = 0
    const opener = vi.fn(async () => {
      n++
      return fakeClient(async () => {
        if (n === 1) throw new Error("Streamable HTTP error: 401 Unauthorized")
        return { toolResult: "ok", content: [] }
      }) as never
    })
    const pool = new McpClientPool(opener as never)
    const cfg = { type: "http" as const, url: "https://up.example/mcp" }
    const pooled = pool.get(cfg, "up")
    await pooled.callTool("t", {}).catch(() => {})
    await pooled.callTool("t", {}).catch(() => {})
    expect(opener).toHaveBeenCalledTimes(2)
  })
})

describe("shared resolveImportConnection", () => {
  it("proxy path and apps-host path see byte-identical configs", async () => {
    await saveImportedMcps({ version: 1, imports: [entry] }, importsPath())
    const viaResolver = (await resolveImportConnection(entry)).config
    const viaApps = await resolveMcpServer({ cwd: home }, "s1", "up", {
      home,
      importedMcpsPath: importsPath(),
    })
    expect(viaApps?.source).toBe("imported")
    expect(JSON.stringify(viaApps?.config)).toBe(JSON.stringify(viaResolver))

    openMock.mockResolvedValue(fakeClient(async () => ({ ok: 1 })))
    await new McpProxyRegistry().callTool("up", "t", {})
    expect(JSON.stringify(openMock.mock.calls[0]![0])).toBe(
      JSON.stringify(viaResolver)
    )
  })
})
