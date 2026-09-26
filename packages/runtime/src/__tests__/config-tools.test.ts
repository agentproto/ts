/**
 * `config_get` / `config_set` (PR-2) over the MCP transport. Every test
 * injects a temp-dir config path + a fresh `RuntimeEvents` bus via
 * `ConfigToolsDeps` — nothing here ever touches the real
 * `~/.agentproto/config.json`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerConfigTools, deriveValueType, type ConfigToolsDeps } from "../config-tools.js"
import { loadConfig, saveConfig, type AgentprotoConfig } from "../config.js"
import { createRuntimeEvents, type RuntimeEvents } from "../events.js"
import { WORKTREE_ISOLATION_ENV } from "../worktree-isolation.js"
import { PROVENANCE_WRAP_GH_ENV } from "../gh-provenance-shim.js"

function parse(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const t = content?.find(c => c.type === "text")?.text
  if (!t) throw new Error("tool returned no text content")
  return JSON.parse(t)
}

let dir: string
let configPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agp-config-tools-"))
  configPath = join(dir, "config.json")
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  delete process.env[WORKTREE_ISOLATION_ENV]
  delete process.env[PROVENANCE_WRAP_GH_ENV]
})

async function writeCfg(cfg: AgentprotoConfig): Promise<void> {
  await saveConfig(cfg, configPath)
}

function makeDeps(
  bootConfig: AgentprotoConfig,
  extra?: Partial<ConfigToolsDeps>,
): ConfigToolsDeps {
  return {
    loadCfg: () => loadConfig(configPath),
    saveCfg: next => saveConfig(next, configPath),
    configPath: () => configPath,
    bootConfig,
    events: createRuntimeEvents(),
    ...extra,
  }
}

async function setupClient(deps: ConfigToolsDeps): Promise<Client> {
  const server = new McpServer({ name: "config-tools-test", version: "0.0.0" })
  registerConfigTools(server, deps)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "config-tools-test-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

function findKey(result: any, path: string): any {
  const row = result.keys.find((k: { path: string }) => k.path === path)
  if (!row) throw new Error(`no row for ${path} (got ${result.keys.map((k: any) => k.path).join(", ")})`)
  return row
}

describe("config_get", () => {
  it("reports source=env + envOverride when an env var shadows the file value", async () => {
    await writeCfg({ worktrees: { isolation: "never" } })
    process.env[WORKTREE_ISOLATION_ENV] = "always"
    const client = await setupClient(makeDeps({}))
    const res = parse(
      await client.callTool({ name: "config_get", arguments: { keys: ["worktrees.isolation"] } }),
    )
    const row = findKey(res, "worktrees.isolation")
    expect(row.source).toBe("env")
    expect(row.envOverride).toBe(WORKTREE_ISOLATION_ENV)
    expect(row.effective).toBe("always")
    expect(row.value).toBe("never")
    await client.close()
  })

  it("falls back to the registry default when unset and no env override", async () => {
    await writeCfg({})
    const client = await setupClient(makeDeps({}))
    const res = parse(
      await client.callTool({ name: "config_get", arguments: { keys: ["daemon.port"] } }),
    )
    const row = findKey(res, "daemon.port")
    expect(row.source).toBe("default")
    expect(row.effective).toBe(18790)
    expect(row.value).toBeUndefined()
    await client.close()
  })

  it("never returns a secret's raw value — only set/fingerprint/last4", async () => {
    const secret = "s".repeat(40)
    await writeCfg({ daemon: { authToken: secret } })
    const client = await setupClient(makeDeps({ daemon: { authToken: secret } }))
    const raw = await client.callTool({ name: "config_get", arguments: { keys: ["daemon.authToken"] } })
    expect(JSON.stringify(raw)).not.toContain(secret)
    const row = findKey(parse(raw), "daemon.authToken")
    expect(row.secret.set).toBe(true)
    expect(row.secret.fingerprint).toBeTruthy()
    expect(row.secret.last4).toBe("ssss")
    // `value`/`effective` go through the same deep redaction as `secret` —
    // a direct scalar secret leaf gets the full identity, not just `{set}`.
    expect(row.value).toEqual({ set: true, fingerprint: row.secret.fingerprint, last4: "ssss" })
    await client.close()
  })

  it("redacts acpAgents.*.env values to per-key presence only", async () => {
    await writeCfg({
      acpAgents: { myagent: { bin: "myagent", env: { TOKEN: "abc123" } } },
    })
    const client = await setupClient(makeDeps({}))
    const raw = await client.callTool({
      name: "config_get",
      arguments: { keys: ["acpAgents.myagent.env"] },
    })
    expect(JSON.stringify(raw)).not.toContain("abc123")
    const row = findKey(parse(raw), "acpAgents.myagent.env")
    expect(row.secret).toEqual({ TOKEN: { set: true } })
    await client.close()
  })

  it("pendingRestart is true when a restart-class key changed since boot", async () => {
    await writeCfg({ daemon: { label: "new-label" } })
    const client = await setupClient(makeDeps({ daemon: { label: "boot-label" } }))
    const res = parse(
      await client.callTool({ name: "config_get", arguments: { keys: ["daemon.label"] } }),
    )
    expect(findKey(res, "daemon.label").pendingRestart).toBe(true)
    await client.close()
  })

  it("pendingRestart is false when unchanged since boot, and always false for a hot key", async () => {
    await writeCfg({ daemon: { label: "same" }, titler: { model: "z-ai/glm-5" } })
    const client = await setupClient(makeDeps({ daemon: { label: "same" } }))
    const res = parse(
      await client.callTool({
        name: "config_get",
        arguments: { keys: ["daemon.label", "titler.model"] },
      }),
    )
    expect(findKey(res, "daemon.label").pendingRestart).toBe(false)
    expect(findKey(res, "titler.model").pendingRestart).toBe(false)
    await client.close()
  })

  it("no filter returns every registry key; a wildcard key expands to concrete rows present in the file", async () => {
    await writeCfg({
      acpAgents: {
        "agent-a": { bin: "a" },
        "agent-b": { bin: "b" },
      },
    })
    const client = await setupClient(makeDeps({}))
    const res = parse(await client.callTool({ name: "config_get", arguments: {} }))
    const paths = res.keys.map((k: { path: string }) => k.path)
    expect(paths).toContain("acpAgents.agent-a.bin")
    expect(paths).toContain("acpAgents.agent-b.bin")
    expect(paths).toContain("daemon.port")
    expect(res.revision).toEqual(expect.any(String))
    expect(res.path).toBe(configPath)
    await client.close()
  })

  it("section filters to just that section's keys", async () => {
    await writeCfg({})
    const client = await setupClient(makeDeps({}))
    const res = parse(await client.callTool({ name: "config_get", arguments: { section: "remote" } }))
    expect(res.keys.every((k: { path: string }) => k.path.startsWith("tunnel.") || k.path.startsWith("pairing."))).toBe(true)
    expect(res.keys.length).toBeGreaterThan(0)
    await client.close()
  })

  it("deep-redacts a secret nested under a non-secret container key (profiles, adapter auth)", async () => {
    // `profiles` is `writable: false` but NOT itself `secret: true` — it's a
    // record of per-profile daemon/tunnel overrides that can still nest a
    // REAL secret leaf arbitrarily deep. Same for a per-adapter `auth` block
    // read via the whole-object `defaults` blob. Neither must ever leak its
    // raw value, since GET /config's read side must stay secret-safe too.
    const secrets = {
      alphaTunnel: "alpha-tunnel-secret-1234",
      alphaDaemon: "alpha-daemon-secret-5678",
      betaTunnel: "beta-tunnel-secret-9999",
      adapterSub: "adapter-sub-token-aaaa",
      adapterApiKey: "adapter-api-key-bbbb",
    }
    await writeCfg({
      profiles: {
        alpha: {
          tunnel: { token: secrets.alphaTunnel },
          daemon: { authToken: secrets.alphaDaemon },
        },
        beta: { tunnel: { token: secrets.betaTunnel } },
      },
      defaults: {
        adapters: {
          "claude-code": { auth: { token: secrets.adapterSub, apiKey: secrets.adapterApiKey } },
        },
      },
    })
    const client = await setupClient(makeDeps({}))
    const raw = await client.callTool({ name: "config_get", arguments: {} })
    const json = JSON.stringify(raw)
    for (const secret of Object.values(secrets)) {
      expect(json).not.toContain(secret)
    }
    const parsed = parse(raw)
    const profilesRow = findKey(parsed, "profiles")
    expect(profilesRow.value.alpha.tunnel.token).toMatchObject({ set: true })
    expect(profilesRow.value.alpha.tunnel.token.fingerprint).toBeTruthy()
    expect(profilesRow.value.alpha.daemon.authToken).toMatchObject({ set: true })
    expect(profilesRow.value.beta.tunnel.token).toMatchObject({ set: true })
    // Existing per-leaf secret keys still redact correctly alongside this.
    const authTokenRow = findKey(parsed, "defaults.adapters.claude-code.auth.token")
    expect(authTokenRow.value).toMatchObject({ set: true })
    expect(authTokenRow.secret.fingerprint).toBeTruthy()
    await client.close()
  })

  it("does not redact an ordinary object-valued key with no nested secret", async () => {
    await writeCfg({
      defaults: { adapters: { "claude-code": { options: { model: "sonnet", verbose: true } } } },
    })
    const client = await setupClient(makeDeps({}))
    const res = parse(
      await client.callTool({
        name: "config_get",
        arguments: { keys: ["defaults.adapters.claude-code.options"] },
      }),
    )
    expect(findKey(res, "defaults.adapters.claude-code.options").value).toEqual({
      model: "sonnet",
      verbose: true,
    })
    await client.close()
  })

  it("carries registry metadata (label/help/section/valueType) on every row", async () => {
    await writeCfg({})
    const client = await setupClient(makeDeps({}))
    const res = parse(await client.callTool({ name: "config_get", arguments: { keys: ["spawn.dedupe"] } }))
    const row = findKey(res, "spawn.dedupe")
    expect(row.section).toBe("defaults")
    expect(typeof row.label).toBe("string")
    expect(row.label.length).toBeGreaterThan(0)
    expect(typeof row.help).toBe("string")
    expect(row.help.length).toBeGreaterThan(0)
    expect(row.default).toBe("always")
    await client.close()
  })

  it("valueType: enum key (spawn.dedupe) reports its allowed values", async () => {
    await writeCfg({})
    const client = await setupClient(makeDeps({}))
    const res = parse(await client.callTool({ name: "config_get", arguments: { keys: ["spawn.dedupe"] } }))
    const row = findKey(res, "spawn.dedupe")
    expect(row.valueType).toBe("enum")
    expect(row.enum).toEqual(["always", "on-request"])
    await client.close()
  })

  it("valueType: boolean key reports \"boolean\"", async () => {
    await writeCfg({})
    const client = await setupClient(makeDeps({}))
    const res = parse(
      await client.callTool({ name: "config_get", arguments: { keys: ["provenance.wrapGh"] } }),
    )
    expect(findKey(res, "provenance.wrapGh").valueType).toBe("boolean")
    await client.close()
  })

  it("valueType: string[] key (defaults.skills) reports \"string[]\"", async () => {
    await writeCfg({})
    const client = await setupClient(makeDeps({}))
    const res = parse(
      await client.callTool({ name: "config_get", arguments: { keys: ["defaults.skills"] } }),
    )
    expect(findKey(res, "defaults.skills").valueType).toBe("string[]")
    await client.close()
  })

  it("valueType: object key (defaults.options) reports \"object\"", async () => {
    await writeCfg({})
    const client = await setupClient(makeDeps({}))
    const res = parse(
      await client.callTool({ name: "config_get", arguments: { keys: ["defaults.options"] } }),
    )
    expect(findKey(res, "defaults.options").valueType).toBe("object")
    await client.close()
  })

  it("valueType: an unrecognized schema shape falls back to \"unknown\" and never throws", () => {
    expect(deriveValueType(z.tuple([z.string(), z.number()]))).toEqual({ valueType: "unknown" })
  })
})

describe("deriveValueType (schema introspection)", () => {
  it("derives an integer with min/max bounds from the zod schema's own checks", () => {
    expect(deriveValueType(z.number().int().min(0).max(100))).toEqual({
      valueType: "integer",
      min: 0,
      max: 100,
    })
  })

  it("derives a plain number with no declared bounds", () => {
    expect(deriveValueType(z.number())).toEqual({ valueType: "number" })
  })

  it("unwraps optional/nullable wrappers before inspecting the leaf", () => {
    expect(deriveValueType(z.number().int().min(0).optional())).toEqual({
      valueType: "integer",
      min: 0,
    })
    expect(deriveValueType(z.string().nullable())).toEqual({ valueType: "string" })
  })
})

describe("config_set", () => {
  it("writes a hot key and reports applied=hot", async () => {
    await writeCfg({})
    const client = await setupClient(makeDeps({}))
    const res = parse(
      await client.callTool({ name: "config_set", arguments: { key: "titler.model", value: "z-ai/glm-5" } }),
    )
    expect(res).toMatchObject({ ok: true, key: "titler.model", applied: "hot" })
    expect((await loadConfig(configPath)).titler?.model).toBe("z-ai/glm-5")
    await client.close()
  })

  it("writes a restart-class key and reports applied=restart-required", async () => {
    await writeCfg({})
    const client = await setupClient(makeDeps({}))
    const res = parse(
      await client.callTool({ name: "config_set", arguments: { key: "daemon.label", value: "box-1" } }),
    )
    expect(res).toMatchObject({ ok: true, applied: "restart-required" })
    expect((await loadConfig(configPath)).daemon?.label).toBe("box-1")
    await client.close()
  })

  it("rejects a secret key", async () => {
    await writeCfg({})
    const client = await setupClient(makeDeps({}))
    const res = await client.callTool({
      name: "config_set",
      arguments: { key: "daemon.authToken", value: "x".repeat(20) },
    })
    expect((res as { isError?: boolean }).isError).toBe(true)
    expect((await loadConfig(configPath)).daemon?.authToken).toBeUndefined()
    await client.close()
  })

  it("rejects a lockout key", async () => {
    await writeCfg({})
    const client = await setupClient(makeDeps({}))
    const res = await client.callTool({ name: "config_set", arguments: { key: "daemon.port", value: 9999 } })
    expect((res as { isError?: boolean }).isError).toBe(true)
    await client.close()
  })

  it("rejects an acpAgents.* key (writable: false)", async () => {
    await writeCfg({ acpAgents: { myagent: { bin: "myagent" } } })
    const client = await setupClient(makeDeps({}))
    const res = await client.callTool({
      name: "config_set",
      arguments: { key: "acpAgents.myagent.bin", value: "other" },
    })
    expect((res as { isError?: boolean }).isError).toBe(true)
    expect((await loadConfig(configPath)).acpAgents?.myagent?.bin).toBe("myagent")
    await client.close()
  })

  it("rejects an unknown key", async () => {
    await writeCfg({})
    const client = await setupClient(makeDeps({}))
    const res = await client.callTool({ name: "config_set", arguments: { key: "not.a.real.key", value: 1 } })
    expect((res as { isError?: boolean }).isError).toBe(true)
    await client.close()
  })

  it("rejects a bad type for a writable key", async () => {
    await writeCfg({})
    const client = await setupClient(makeDeps({}))
    const res = await client.callTool({
      name: "config_set",
      arguments: { key: "sessions.attentionDelaySec", value: "not-a-number" },
    })
    expect((res as { isError?: boolean }).isError).toBe(true)
    await client.close()
  })

  it("rejects a stale revision and returns the current one", async () => {
    await writeCfg({})
    const client = await setupClient(makeDeps({}))
    const before = parse(await client.callTool({ name: "config_get", arguments: {} }))
    // Mutate the file out-of-band, simulating a concurrent writer.
    await writeCfg({ daemon: { label: "changed-elsewhere" } })
    const res = await client.callTool({
      name: "config_set",
      arguments: { key: "titler.model", value: "x", revision: before.revision },
    })
    expect((res as { isError?: boolean }).isError).toBe(true)
    const text = (res as { content: Array<{ text: string }> }).content[0]?.text ?? ""
    expect(text).toContain("stale_revision")
    await client.close()
  })

  it("accepts a write when the given revision still matches", async () => {
    await writeCfg({})
    const client = await setupClient(makeDeps({}))
    const before = parse(await client.callTool({ name: "config_get", arguments: {} }))
    const res = parse(
      await client.callTool({
        name: "config_set",
        arguments: { key: "titler.model", value: "z-ai/glm-5", revision: before.revision },
      }),
    )
    expect(res.ok).toBe(true)
    await client.close()
  })

  it("reports shadowedByEnv when an env var overrides the key just written", async () => {
    process.env[PROVENANCE_WRAP_GH_ENV] = "true"
    await writeCfg({})
    const client = await setupClient(makeDeps({}))
    const res = parse(
      await client.callTool({ name: "config_set", arguments: { key: "provenance.wrapGh", value: false } }),
    )
    expect(res.ok).toBe(true)
    expect(res.shadowedByEnv).toBe(PROVENANCE_WRAP_GH_ENV)
    await client.close()
  })

  it("unset deletes the key", async () => {
    await writeCfg({ titler: { model: "z-ai/glm-5" } })
    const client = await setupClient(makeDeps({}))
    const res = parse(
      await client.callTool({ name: "config_set", arguments: { key: "titler.model", unset: true } }),
    )
    expect(res.ok).toBe(true)
    expect((await loadConfig(configPath)).titler?.model).toBeUndefined()
    await client.close()
  })

  it("rejects a call that gives neither value nor unset, and one that gives both", async () => {
    await writeCfg({})
    const client = await setupClient(makeDeps({}))
    const neither = await client.callTool({ name: "config_set", arguments: { key: "titler.model" } })
    expect((neither as { isError?: boolean }).isError).toBe(true)
    const both = await client.callTool({
      name: "config_set",
      arguments: { key: "titler.model", value: "x", unset: true },
    })
    expect((both as { isError?: boolean }).isError).toBe(true)
    await client.close()
  })

  it("emits config:changed on success, with no secret value, and not at all on failure", async () => {
    await writeCfg({})
    const events = createRuntimeEvents()
    const seen: unknown[] = []
    events.on("config:changed", ev => seen.push(ev))
    const client = await setupClient(makeDeps({}, { events }))

    await client.callTool({
      name: "config_set",
      arguments: { key: "titler.model", value: "z-ai/glm-5" },
    })
    expect(seen).toEqual([
      { type: "config:changed", at: expect.any(String), keys: ["titler.model"], applied: "hot" },
    ])

    await client.callTool({ name: "config_set", arguments: { key: "daemon.authToken", value: "x".repeat(20) } })
    expect(seen).toHaveLength(1) // the rejected secret write emitted nothing

    await client.close()
  })

  it("succeeds despite an unrelated pre-existing schema issue already on disk", async () => {
    // A legacy hand-edit / older-daemon-written value that fails schema
    // validation entirely on its own, unrelated to the key this write
    // touches. Before the fix, `validateConfig(next)` having ANY issue at
    // all rejected the write outright — so a single unrelated bad value on
    // disk would have permanently blocked every future config_set call.
    await writeCfg({ worktrees: { isolation: "bogus-legacy-value" as never } })
    const client = await setupClient(makeDeps({}))
    const res = parse(
      await client.callTool({ name: "config_set", arguments: { key: "titler.model", value: "z-ai/glm-5" } }),
    )
    expect(res.ok).toBe(true)
    const onDisk = await loadConfig(configPath)
    expect(onDisk.titler?.model).toBe("z-ai/glm-5")
    // The unrelated pre-existing issue is left untouched, not silently
    // "fixed" by this write.
    expect(onDisk.worktrees?.isolation).toBe("bogus-legacy-value")
    await client.close()
  })
})
