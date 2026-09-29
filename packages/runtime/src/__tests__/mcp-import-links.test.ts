/**
 * P1: imports link to their source (`resolve: live`) and hold secrets behind
 * keychain refs (`secretRefs`). All fixtures live in temp dirs with a fake
 * secret store — never the real home or keychain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const openMock = vi.hoisted(() => vi.fn())
vi.mock("../mcp-client-pool.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../mcp-client-pool.js")>()
  return { ...actual, openMcpClient: openMock }
})

import { McpProxyRegistry } from "../mcp-proxy.js"
import { resolveImportConnection } from "../mcp-import-resolve.js"
import { computeCapabilitiesInventory } from "../capabilities-inventory.js"
import { setMcpCredentialDeps } from "../mcp-credential-deps.js"
import {
  addImport,
  addImportWithSecrets,
  loadImportedMcps,
  saveImportedMcps,
  SECRET_REF_MARKER,
  type ImportedMcpEntry,
} from "../mcp-imports.js"
import type { DiscoveredMcp } from "../mcp-discovery.js"

const SECRET = "s3cr3t-value-DO-NOT-LEAK"

function fakeStore() {
  const map = new Map<string, string>()
  return {
    map,
    hooks: {
      storeMcpSecret: async (ref: string, v: string) => void map.set(ref, v),
      resolveMcpSecret: async (ref: string) => map.get(ref),
    },
  }
}

const httpSnap = (over: Partial<DiscoveredMcp> = {}): DiscoveredMcp => ({
  id: "claude-code:global:up",
  source: "claude-code",
  scope: "global",
  name: "up",
  type: "http",
  url: "https://up.example/mcp",
  headers: { Authorization: `Basic ${SECRET}` },
  ...over,
})

function fakeClient() {
  return {
    listTools: async () => ({ tools: [{ name: "t" }] }),
    callTool: async () => ({ ok: 1 }),
    close: async () => {},
  }
}

let home: string
let prevHome: string | undefined
const importsPath = () => join(home, ".agentproto", "imported-mcps.json")

beforeEach(async () => {
  openMock.mockReset()
  home = await mkdtemp(join(tmpdir(), "mcp-links-"))
  await mkdir(join(home, ".agentproto"), { recursive: true })
  prevHome = process.env.HOME
  process.env.HOME = home
  setMcpCredentialDeps({})
})
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  setMcpCredentialDeps({})
})

describe("file format stays v1 and additive", () => {
  it("a v1 fixture without the new fields loads unchanged", async () => {
    const legacy = {
      id: "a",
      alias: "a",
      addedAt: "2026-01-01T00:00:00.000Z",
      snapshot: httpSnap({ id: "a" }),
    }
    await writeFile(importsPath(), JSON.stringify({ version: 1, imports: [legacy] }))
    const cfg = await loadImportedMcps(importsPath())
    expect(cfg.version).toBe(1)
    expect(cfg.imports[0]).toEqual(legacy)
    expect(cfg.imports[0]).not.toHaveProperty("resolve")
  })
  it("new fields survive a save/load round trip", async () => {
    const { config } = await addImportWithSecrets(
      { version: 1, imports: [] },
      { snapshot: httpSnap() },
      fakeStore().hooks
    )
    await saveImportedMcps(config, importsPath())
    const back = await loadImportedMcps(importsPath())
    expect(back.imports[0]!.resolve).toBe("live")
    expect(back.imports[0]!.origin).toEqual({ kind: "claude-code", scope: "global", name: "up" })
    expect(back.imports[0]!.secretRefs?.headers?.Authorization).toBe(
      "agentproto/mcp-import/claude-code:global:up#header:Authorization"
    )
  })
})

describe("addImport resolve derivation", () => {
  it.each([
    ["claude-code", "global", "live"],
    ["claude-code", "project:/x", "live"],
    ["cursor", "global", "live"],
    ["codex", "global", "live"],
    ["workspace", "workspace:ws", "live"],
    ["claude-code", "local", "snapshot"],
    ["goose", "global", "snapshot"],
  ] as const)("%s/%s -> %s", (source, scope, expected) => {
    const cfg = addImport(
      { version: 1, imports: [] },
      { snapshot: httpSnap({ id: `${source}:${scope}:n`, source, scope, name: "n" }) }
    )
    expect(cfg.imports[0]!.resolve).toBe(expected)
  })
  it("plugin:* import defaults to snapshot", () => {
    const cfg = addImport(
      { version: 1, imports: [] },
      {
        snapshot: {
          id: "plugin:local-browser:X",
          source: "plugin" as unknown as DiscoveredMcp["source"],
          scope: "plugin:local-browser",
          name: "X",
          type: "stdio",
          command: "x",
        },
      }
    )
    expect(cfg.imports[0]!.resolve).toBe("snapshot")
  })
})

describe("secret extraction on import", () => {
  it("moves a literal `Basic` header to secretRefs; resolved verbatim into the same key", async () => {
    const { map, hooks } = fakeStore()
    const { config, entry, warnings } = await addImportWithSecrets(
      { version: 1, imports: [] },
      { snapshot: httpSnap() },
      hooks
    )
    expect(warnings).toEqual([])
    expect(entry.snapshot.headers).toEqual({ Authorization: SECRET_REF_MARKER })
    expect([...map.values()]).toEqual([`Basic ${SECRET}`])
    await saveImportedMcps(config, importsPath())
    expect(await readFile(importsPath(), "utf8")).not.toContain(SECRET)

    const r = await resolveImportConnection(
      { ...entry, resolve: "snapshot" },
      hooks
    )
    expect(r.config.headers).toEqual({ Authorization: `Basic ${SECRET}` })
    expect(r.stale).toBeUndefined()
  })

  it("moves non-Authorization headers and literal env; NOT ${VAR} placeholders", async () => {
    const { map, hooks } = fakeStore()
    const { entry } = await addImportWithSecrets(
      { version: 1, imports: [] },
      {
        snapshot: httpSnap({
          type: "stdio",
          command: "x",
          url: undefined,
          headers: { "X-Api-Key": "k1" },
          env: { TOKEN: "lit", FROM_ENV: "${REPLICATE_API_TOKEN}", EMPTY: "" },
        }),
      },
      hooks
    )
    expect(entry.secretRefs?.headers).toHaveProperty("X-Api-Key")
    expect(entry.secretRefs?.env).toHaveProperty("TOKEN")
    expect(entry.secretRefs?.env).not.toHaveProperty("FROM_ENV")
    expect(entry.secretRefs?.env).not.toHaveProperty("EMPTY")
    expect(entry.snapshot.env?.FROM_ENV).toBe("${REPLICATE_API_TOKEN}")
    expect(map.size).toBe(2)
  })

  it("hook absent -> literal kept + warning (no value in the warning)", async () => {
    const { entry, warnings } = await addImportWithSecrets(
      { version: 1, imports: [] },
      { snapshot: httpSnap() },
      {}
    )
    expect(entry.snapshot.headers?.Authorization).toBe(`Basic ${SECRET}`)
    expect(entry.secretRefs).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings.join("")).not.toContain(SECRET)
  })

  it("a failing store keeps the literal for that key and warns without the value", async () => {
    const { entry, warnings } = await addImportWithSecrets(
      { version: 1, imports: [] },
      { snapshot: httpSnap() },
      {
        storeMcpSecret: async () => {
          throw new Error("keychain locked")
        },
      }
    )
    expect(entry.snapshot.headers?.Authorization).toBe(`Basic ${SECRET}`)
    expect(warnings.join("")).toContain("keychain locked")
    expect(warnings.join("")).not.toContain(SECRET)
  })
})

describe("resolveImportConnection (live)", () => {
  const linked = async (hooks = fakeStore().hooks) =>
    (await addImportWithSecrets({ version: 1, imports: [] }, { snapshot: httpSnap() }, hooks))
      .entry

  it("live values win for url; the secret wins over live headers", async () => {
    const { hooks } = fakeStore()
    const entry = await linked(hooks)
    const live = httpSnap({ url: "https://up.example/v2/mcp", headers: { Authorization: "Bearer stale-in-source" } })
    const r = await resolveImportConnection(entry, hooks, { discover: async () => [live] })
    expect(r.config.url).toBe("https://up.example/v2/mcp")
    expect(r.config.headers).toEqual({ Authorization: `Basic ${SECRET}` })
    expect(r.stale).toBeUndefined() // same origin, path change allowed
  })

  it("live host change: secrets are NOT injected, stale = upstream-changed", async () => {
    const { hooks } = fakeStore()
    const entry = await linked(hooks)
    const live = httpSnap({ url: "https://evil.example/mcp", headers: { authorization: "x", "X-Other": "ok" } })
    const r = await resolveImportConnection(entry, hooks, { discover: async () => [live] })
    expect(r.config.url).toBe("https://evil.example/mcp")
    expect(r.config.headers).toEqual({ "X-Other": "ok" })
    expect(r.stale?.reason).toBe("upstream-changed")
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })

  it("live port change also counts as a different upstream", async () => {
    const { hooks } = fakeStore()
    const entry = await linked(hooks)
    const live = httpSnap({ url: "https://up.example:8443/mcp" })
    const r = await resolveImportConnection(entry, hooks, { discover: async () => [live] })
    expect(r.stale?.reason).toBe("upstream-changed")
    expect(r.config.headers).toEqual({})
  })

  it("stdio command change: env secrets are NOT injected", async () => {
    const { hooks } = fakeStore()
    const snap = httpSnap({
      id: "claude-code:global:sx", name: "sx", type: "stdio", url: undefined,
      command: "good-bin", args: ["--a"], headers: undefined, env: { TOKEN: SECRET },
    })
    const { entry } = await addImportWithSecrets({ version: 1, imports: [] }, { snapshot: snap }, hooks)
    const live = { ...snap, command: "other-bin", env: { TOKEN: "live-lit", KEEP: "1" } }
    const r = await resolveImportConnection(entry, hooks, { discover: async () => [live] })
    expect(r.config.command).toBe("other-bin")
    expect(r.config.env).toEqual({ KEEP: "1" })
    expect(r.stale?.reason).toBe("upstream-changed")
    const same = await resolveImportConnection(entry, hooks, { discover: async () => [{ ...snap, env: undefined }] })
    expect(same.config.env).toEqual({ TOKEN: SECRET })
  })

  it("a rename at the source auto-heals by url within the same source+scope", async () => {
    const { hooks } = fakeStore()
    const entry = await linked(hooks)
    const renamed = httpSnap({
      id: "claude-code:global:up2",
      name: "up2",
      url: "https://up.example/mcp/",
      headers: undefined,
    })
    const r = await resolveImportConnection(entry, hooks, { discover: async () => [renamed] })
    expect(r.stale).toBeUndefined()
    expect(r.origin?.name).toBe("up2")
    expect(r.config.headers).toEqual({ Authorization: `Basic ${SECRET}` })
  })

  it("does not heal across a different scope", async () => {
    const { hooks } = fakeStore()
    const entry = await linked(hooks)
    const other = httpSnap({ id: "claude-code:project:/p:up", scope: "project:/p" })
    const r = await resolveImportConnection(entry, hooks, { discover: async () => [other] })
    expect(r.stale?.reason).toBe("source-entry-missing")
  })

  it("source deleted -> snapshot + stale (secret still applied)", async () => {
    const { hooks } = fakeStore()
    const entry = await linked(hooks)
    const r = await resolveImportConnection(entry, hooks, { discover: async () => [] })
    expect(r.stale).toEqual({ reason: "source-entry-missing" })
    expect(r.config.url).toBe("https://up.example/mcp")
    expect(r.config.headers).toEqual({ Authorization: `Basic ${SECRET}` })
  })

  it("an unresolvable ref never sends the marker; stale names the key only", async () => {
    const entry = await linked()
    const live = httpSnap({ headers: undefined })
    const r = await resolveImportConnection(entry, {}, { discover: async () => [live] })
    expect(r.config.headers).toEqual({})
    expect(r.stale?.reason).toBe("secret-unresolved: headers.Authorization")
    const both = await resolveImportConnection(entry, {}, { discover: async () => [] })
    expect(both.stale?.reason).toBe(
      "source-entry-missing; secret-unresolved: headers.Authorization"
    )
    expect(JSON.stringify(r)).not.toContain(SECRET_REF_MARKER)
  })

  it("resolve: snapshot never runs discovery", async () => {
    const discover = vi.fn(async () => [] as DiscoveredMcp[])
    const entry = { ...(await linked()), resolve: "snapshot" as const }
    await resolveImportConnection(entry, fakeStore().hooks, { discover })
    expect(discover).not.toHaveBeenCalled()
  })
})

describe("McpProxyRegistry invalidation + surfaces", () => {
  const writeSource = async (url: string) => {
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { up: { type: "http", url } } })
    )
  }

  it("bumping the live source file's mtime forces a reconnect", async () => {
    const { hooks } = fakeStore()
    setMcpCredentialDeps(hooks)
    await writeSource("https://up.example/mcp")
    const { config } = await addImportWithSecrets(
      { version: 1, imports: [] },
      { snapshot: httpSnap({ headers: undefined }) },
      hooks
    )
    await saveImportedMcps(config, importsPath())
    openMock.mockImplementation(async () => fakeClient())
    const reg = new McpProxyRegistry()
    await reg.callTool("up", "t", {})
    await reg.callTool("up", "t", {})
    expect(openMock).toHaveBeenCalledTimes(1)

    await writeSource("https://moved.example/mcp")
    const future = new Date(Date.now() + 60_000)
    await utimes(join(home, ".claude.json"), future, future)
    await reg.callTool("up", "t", {})
    expect(openMock).toHaveBeenCalledTimes(2)
    expect(openMock.mock.calls[1]![0].url).toBe("https://moved.example/mcp")
  })

  it("status + inventory expose resolve/stale/secret KEY names, never values", async () => {
    const { hooks } = fakeStore()
    setMcpCredentialDeps(hooks)
    // No claude.json on disk -> live lookup misses -> stale.
    const { config } = await addImportWithSecrets(
      { version: 1, imports: [] },
      { snapshot: httpSnap() },
      hooks
    )
    await saveImportedMcps(config, importsPath())
    openMock.mockImplementation(async () => fakeClient())
    const reg = new McpProxyRegistry()
    await reg.callTool("up", "t", {})
    const [summary] = await reg.listAliases()
    expect(summary).toMatchObject({
      resolve: "live",
      stale: { reason: "source-entry-missing" },
      secretRefKeys: { headers: ["Authorization"] },
    })

    const inv = await computeCapabilitiesInventory({
      mcpProxy: reg,
      listAgentAdapters: async () => [],
      loadImportedMcps: () => loadImportedMcps(importsPath()),
      discoverMcps: async () => [],
    } as never)
    const imp = inv.mcp.imported[0]!
    expect(imp).toMatchObject({
      resolve: "live",
      stale: { reason: "source-entry-missing" },
      secretRefKeys: { headers: ["Authorization"] },
    })
    for (const blob of [JSON.stringify(summary), JSON.stringify(inv), await readFile(importsPath(), "utf8")]) {
      expect(blob).not.toContain(SECRET)
    }
  })
})
