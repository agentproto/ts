/**
 * Daemon-side AIP-72 store wiring (`memory-stores.ts`): the default root
 * under the agentproto home, the `memory.root` config override, the AIP-42
 * `memory` binding, and store-root resolution for an agent's
 * `memory.store`. Pure path logic plus one temp-dir store; no network.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { validateConfigKeyValue } from "../config-schema.js"
import {
  defaultMemoryRoot,
  memoryProjectionEnabled,
  memoryStoreAt,
  parseAgentMemoryBinding,
  resolveMemoryStoreRoot,
  setDefaultMemoryRoot,
} from "../memory-stores.js"

afterEach(() => setDefaultMemoryRoot(undefined))

describe("defaultMemoryRoot", () => {
  it("defaults to ~/.agentproto/memory", () => {
    expect(defaultMemoryRoot()).toBe(join(homedir(), ".agentproto", "memory"))
  })

  it("follows the memory.root config override: absolute, ~/ and home-relative", () => {
    setDefaultMemoryRoot("/srv/memory")
    expect(defaultMemoryRoot()).toBe("/srv/memory")
    setDefaultMemoryRoot("~/notes/memory")
    expect(defaultMemoryRoot()).toBe(join(homedir(), "notes", "memory"))
    setDefaultMemoryRoot("team/memory")
    expect(defaultMemoryRoot()).toBe(join(homedir(), "team", "memory"))
    setDefaultMemoryRoot(undefined)
    expect(defaultMemoryRoot()).toBe(join(homedir(), ".agentproto", "memory"))
  })

  it("memory.root is a typed config key", () => {
    expect(validateConfigKeyValue("memory.root", "/srv/memory").ok).toBe(true)
    expect(validateConfigKeyValue("memory.root", 42).ok).toBe(false)
  })
})

describe("parseAgentMemoryBinding / memoryProjectionEnabled", () => {
  it("reads enabled, store and anchors and drops the rest", () => {
    expect(
      parseAgentMemoryBinding({ enabled: true, store: "./m", anchors: ["project:a"], scope: "per-thread" }),
    ).toEqual({ enabled: true, store: "./m", anchors: ["project:a"] })
    expect(parseAgentMemoryBinding(undefined)).toBeUndefined()
    expect(parseAgentMemoryBinding("yes")).toBeUndefined()
    expect(parseAgentMemoryBinding({ scope: "per-thread" })).toBeUndefined()
  })

  it("is on for an AIP-72 binding unless enabled is false", () => {
    expect(memoryProjectionEnabled(undefined)).toBe(false)
    expect(memoryProjectionEnabled({ enabled: true })).toBe(true)
    expect(memoryProjectionEnabled({ store: "./m" })).toBe(true)
    expect(memoryProjectionEnabled({ anchors: ["global"] })).toBe(true)
    expect(memoryProjectionEnabled({ enabled: false, store: "./m" })).toBe(false)
  })
})

describe("resolveMemoryStoreRoot", () => {
  it("uses the daemon default when the agent names no store", () => {
    setDefaultMemoryRoot("/srv/memory")
    expect(resolveMemoryStoreRoot({ workspaceRoot: "/ws" })).toEqual({ root: "/srv/memory" })
  })

  it("resolves a files root: workspace-relative, absolute, ~/", () => {
    expect(resolveMemoryStoreRoot({ store: "./memory", workspaceRoot: "/ws" })).toEqual({ root: "/ws/memory" })
    expect(resolveMemoryStoreRoot({ store: "shared/memory", workspaceRoot: "/ws" })).toEqual({
      root: "/ws/shared/memory",
    })
    expect(resolveMemoryStoreRoot({ store: "/abs/memory", workspaceRoot: "/ws" })).toEqual({ root: "/abs/memory" })
    expect(resolveMemoryStoreRoot({ store: "~/memory" })).toEqual({ root: join(homedir(), "memory") })
  })

  it("falls back to the default with a warning for a store id it cannot resolve", () => {
    setDefaultMemoryRoot("/srv/memory")
    const resolved = resolveMemoryStoreRoot({ store: "gbrain", workspaceRoot: "/ws" })
    expect(resolved.root).toBe("/srv/memory")
    expect(resolved.warning).toMatch(/gbrain/)
  })
})

describe("memoryStoreAt", () => {
  it("keeps one store per resolved root", () => {
    expect(memoryStoreAt("/tmp/a")).toBe(memoryStoreAt("/tmp/a/"))
    expect(memoryStoreAt("/tmp/a")).not.toBe(memoryStoreAt("/tmp/b"))
  })
})
