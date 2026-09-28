/**
 * Model roles: the precedence (input > workspace > daemon > default), source
 * reporting, the `model_roles` tool, and `config_set models.<role>`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import {
  DEFAULT_MODEL_ROLES,
  isKnownModelId,
  listModelRoles,
  parseModelRoleRef,
  resolveModelRole,
  unknownModelRoleIds,
} from "../model-roles.js"
import { modelRoles, registerModelRolesTools } from "../model-roles-tools.js"
import { configGet, configSet, type ConfigToolsDeps } from "../config-tools.js"
import { getConfigKey, loadConfig, saveConfig, setConfigKey, type AgentprotoConfig } from "../config.js"
import { findConfigKey, validateConfig } from "../config-schema.js"
import { createRuntimeEvents } from "../events.js"

describe("resolveModelRole precedence", () => {
  it("input beats workspace beats daemon beats default", () => {
    const ctx = {
      input: { "review.small": "in-model" },
      workspace: { "review.small": "ws-model" },
      daemon: { "review.small": "daemon-model" },
    }
    expect(resolveModelRole("review.small", ctx)).toMatchObject({ model: "in-model", source: "input" })
    expect(resolveModelRole("review.small", { ...ctx, input: {} })).toMatchObject({ model: "ws-model", source: "workspace" })
    expect(resolveModelRole("review.small", { daemon: ctx.daemon })).toMatchObject({ model: "daemon-model", source: "daemon" })
    expect(resolveModelRole("review.small")).toMatchObject({
      model: DEFAULT_MODEL_ROLES["review.small"],
      source: "default",
    })
  })

  it("a role no layer configures falls to the built-in default; an unknown role resolves to undefined", () => {
    expect(resolveModelRole("judge.session", { daemon: { "review.pr": "x" } })).toMatchObject({
      model: DEFAULT_MODEL_ROLES["judge.session"],
      source: "default",
    })
    expect(resolveModelRole("nope.nothing", { daemon: { "review.pr": "x" } })).toBeUndefined()
  })

  it("skips empty / malformed layer values instead of stopping there", () => {
    const r = resolveModelRole("review.large", {
      input: { "review.large": "  " },
      workspace: { "review.large": 42 as unknown as string },
      daemon: { "review.large": { route: "openrouter" } },
    })
    expect(r).toMatchObject({ model: DEFAULT_MODEL_ROLES["review.large"], source: "default" })
  })

  it("carries route/profile from an object value", () => {
    const r = resolveModelRole("review.pr", { daemon: { "review.pr": { model: "z-ai/glm-5.3-flash", route: "openrouter", profile: "or" } } })
    expect(r).toEqual({ role: "review.pr", model: "z-ai/glm-5.3-flash", route: "openrouter", profile: "or", source: "daemon" })
  })

  it("listModelRoles reports every built-in plus configured roles with sources, sorted", () => {
    const list = listModelRoles({ daemon: { "review.pr": "d", "custom.role": "c" } })
    expect(list.map(r => r.role)).toEqual(["custom.role", "judge.session", "review.large", "review.pr", "review.small"])
    expect(list.find(r => r.role === "review.pr")?.source).toBe("daemon")
    expect(list.find(r => r.role === "custom.role")?.source).toBe("daemon")
    expect(list.find(r => r.role === "review.small")?.source).toBe("default")
  })

  it("parseModelRoleRef", () => {
    expect(parseModelRoleRef("role:review.large")).toBe("review.large")
    expect(parseModelRoleRef("claude-sonnet-5-5")).toBeUndefined()
    expect(parseModelRoleRef("role:")).toBeUndefined()
  })
})

describe("catalog validation", () => {
  it("knows every built-in default id", () => {
    for (const id of Object.values(DEFAULT_MODEL_ROLES)) expect(isKnownModelId(id), id).toBe(true)
  })
  it("flags an id the catalog has never heard of", () => {
    expect(unknownModelRoleIds({ "review.pr": "totally-made-up-model-9", "review.small": "claude-haiku-4-5-20251001" })).toEqual([
      { role: "review.pr", model: "totally-made-up-model-9" },
    ])
  })
})

describe("config: models.<role> keys", () => {
  it("get/set treat everything after `models.` as one role key", () => {
    const next = setConfigKey({}, "models.review.pr", "m")
    expect(next).toEqual({ models: { "review.pr": "m" } })
    expect(getConfigKey(next, "models.review.pr")).toBe("m")
    expect(setConfigKey(next, "models.review.pr", undefined)).toEqual({ models: {} })
  })
  it("registry maps any models.<role> onto the models.* entry; schema accepts string or object", () => {
    expect(findConfigKey("models.review.pr")?.path).toBe("models.*")
    expect(validateConfig({ models: { "review.pr": "x", "judge.session": { model: "y", route: "openrouter" } } }).ok).toBe(true)
    expect(validateConfig({ models: { "review.pr": 3 } }).ok).toBe(false)
  })
})

describe("model_roles tool + config_set", () => {
  let dir: string
  let repo: string
  let configPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agp-model-roles-"))
    repo = join(dir, "repo")
    await import("node:fs/promises").then(fs => fs.mkdir(repo))
    configPath = join(dir, "config.json")
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const deps = (): ConfigToolsDeps => ({
    loadCfg: () => loadConfig(configPath),
    saveCfg: next => saveConfig(next, configPath),
    configPath: () => configPath,
    bootConfig: {},
    events: createRuntimeEvents(),
  })

  it("resolves workspace over daemon over default and reports each source; explicit inputs win", async () => {
    const cfg: AgentprotoConfig = { models: { "review.small": "daemon-small", "review.large": "daemon-large" } }
    await saveConfig(cfg, configPath)
    await writeFile(join(repo, "agentproto.json"), JSON.stringify({ models: { "review.large": "ws-large" } }))
    const out = await modelRoles(
      { repoRoot: repo, inputs: { "judge.session": "in-judge", "review.small": "" } },
      { loadCfg: () => loadConfig(configPath), resolveRoot: async i => i.repoRoot },
    )
    const by = Object.fromEntries(out.roles.map(r => [r.role, r]))
    expect(by["judge.session"]).toMatchObject({ model: "in-judge", source: "input" })
    expect(by["review.large"]).toMatchObject({ model: "ws-large", source: "workspace" })
    expect(by["review.small"]).toMatchObject({ model: "daemon-small", source: "daemon" })
    expect(by["review.pr"]?.source).toBe("default")
    expect(out.models["review.large"]).toBe("ws-large")
    expect(out.workspaceRoot).toBe(repo)
  })

  it("tolerates a missing / unreadable agentproto.json and no resolvable workspace", async () => {
    const out = await modelRoles({ roles: ["review.small"] }, { loadCfg: async () => ({}), resolveRoot: async () => repo })
    expect(out.roles).toEqual([{ role: "review.small", model: DEFAULT_MODEL_ROLES["review.small"], source: "default" }])
    const none = await modelRoles({ roles: ["review.small"] }, { loadCfg: async () => ({}), resolveRoot: async () => undefined })
    expect(none.workspaceRoot).toBeUndefined()
  })

  it("is served over MCP", async () => {
    await saveConfig({ models: { "review.pr": "openrouter/z-ai/glm-5.3-flash" } }, configPath)
    const server = new McpServer({ name: "t", version: "0" })
    registerModelRolesTools(server, { loadCfg: () => loadConfig(configPath), resolveRoot: async () => undefined })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const client = new Client({ name: "c", version: "0" })
    await client.connect(ct)
    const res = (await client.callTool({ name: "model_roles", arguments: { roles: ["review.pr", "judge.session"] } })) as {
      content: Array<{ text: string }>
    }
    const body = JSON.parse(res.content[0]!.text)
    expect(body.roles).toEqual([
      { role: "review.pr", model: "openrouter/z-ai/glm-5.3-flash", source: "daemon" },
      { role: "judge.session", model: DEFAULT_MODEL_ROLES["judge.session"], source: "default" },
    ])
    expect(body.precedence).toEqual(["input", "workspace", "daemon", "default"])
  })

  it("config_set models.<role> writes the role, warns (not blocks) on an unknown id, and config_get lists it", async () => {
    const ok = await configSet({ key: "models.review.pr", value: "claude-haiku-4-5-20251001" }, deps())
    expect(ok).toMatchObject({ ok: true, applied: "hot" })
    expect((ok as { warnings?: string[] }).warnings).toBeUndefined()

    const warned = await configSet({ key: "models.judge.session", value: "totally-made-up-model-9" }, deps())
    expect(warned.ok).toBe(true)
    expect((warned as { warnings: string[] }).warnings[0]).toContain("totally-made-up-model-9")
    expect((await loadConfig(configPath)).models).toEqual({
      "review.pr": "claude-haiku-4-5-20251001",
      "judge.session": "totally-made-up-model-9",
    })

    const bad = await configSet({ key: "models.review.small", value: 12 }, deps())
    expect(bad).toMatchObject({ ok: false, error: "invalid_value" })

    const got = await configGet({ section: "models" }, deps())
    const rows = got.keys.filter(k => k.path.startsWith("models."))
    expect(rows.map(r => r.path).sort()).toEqual(["models.judge.session", "models.review.pr"])

    const unset = await configSet({ key: "models.review.pr", unset: true }, deps())
    expect(unset.ok).toBe(true)
    expect((await loadConfig(configPath)).models).toEqual({ "judge.session": "totally-made-up-model-9" })
  })
})
