/**
 * The policy layer for `agent_start.attach` — the pure decision matrix
 * (`decideSpawnAttach`) and the env/config resolver (`loadSpawnAttach`). No
 * daemon, no filesystem: the matrix is pure, and the resolver takes an
 * injected config loader so it never reads the real `~/.agentproto/config.json`.
 * The side-effecting half (attribution through `spawnAgentSession`) is covered
 * against the spawn path in session-spawn's own suites.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  DEFAULT_SPAWN_ATTACH,
  decideSpawnAttach,
  loadSpawnAttach,
  normalizeAttachField,
  parseSpawnAttachMode,
  SPAWN_ATTACH_ENV,
  type AttachField,
} from "../spawn-attach.js"

describe("normalizeAttachField", () => {
  it("treats absent as no explicit request", () => {
    expect(normalizeAttachField(undefined)).toBeUndefined()
  })
  it("treats false as a deliberate detach", () => {
    expect(normalizeAttachField(false)).toEqual({ detached: true })
  })
  it("treats true as a bare opt-in", () => {
    expect(normalizeAttachField(true)).toEqual({ optIn: true })
  })
  it("carries an explicit parent pin (and is itself an opt-in)", () => {
    expect(normalizeAttachField({ parent: "s1" })).toEqual({ optIn: true, parent: "s1" })
  })
  it("an object with no parent is still an opt-in", () => {
    expect(normalizeAttachField({})).toEqual({ optIn: true })
  })
})

describe("decideSpawnAttach — default (always) mode", () => {
  const mode = "always" as const
  it("attaches to the derived auto-parent when the caller made no choice", () => {
    expect(decideSpawnAttach({ mode, field: undefined, autoParent: "sup" })).toEqual({
      parent: "sup",
      detached: false,
    })
  })
  it("prefers an explicit hint over the implicit auto-parent", () => {
    expect(
      decideSpawnAttach({ mode, field: undefined, autoParent: "auto", hint: "hint" }),
    ).toEqual({ parent: "hint", detached: false })
  })
  it("yields a parentless root when nothing is derivable", () => {
    expect(decideSpawnAttach({ mode, field: undefined })).toEqual({
      parent: undefined,
      detached: false,
    })
  })
  it("attach:false forces an independent root even with a derivable parent", () => {
    expect(decideSpawnAttach({ mode, field: false, autoParent: "sup", hint: "h" })).toEqual({
      parent: undefined,
      detached: true,
    })
  })
  it("an explicit {parent} pin wins over hint and auto", () => {
    expect(
      decideSpawnAttach({ mode, field: { parent: "pin" }, autoParent: "auto", hint: "hint" }),
    ).toEqual({ parent: "pin", detached: false })
  })
})

describe("decideSpawnAttach — on-request mode", () => {
  const mode = "on-request" as const
  it("does NOT auto-attach the derived parent when the caller made no choice", () => {
    expect(decideSpawnAttach({ mode, field: undefined, autoParent: "sup" })).toEqual({
      parent: undefined,
      detached: false,
    })
  })
  it("still honours an explicit hint (an explicit caller request)", () => {
    expect(decideSpawnAttach({ mode, field: undefined, hint: "hint", autoParent: "sup" })).toEqual({
      parent: "hint",
      detached: false,
    })
  })
  it("attach:true opts in to the derived parent despite the policy", () => {
    expect(decideSpawnAttach({ mode, field: true, autoParent: "sup" })).toEqual({
      parent: "sup",
      detached: false,
    })
  })
  it("attach:false still forces a detached root", () => {
    expect(decideSpawnAttach({ mode, field: false, autoParent: "sup" })).toEqual({
      parent: undefined,
      detached: true,
    })
  })
})

describe("parseSpawnAttachMode", () => {
  it("accepts the two valid modes", () => {
    expect(parseSpawnAttachMode("always")).toBe("always")
    expect(parseSpawnAttachMode("on-request")).toBe("on-request")
  })
  it("rejects anything else", () => {
    expect(parseSpawnAttachMode("never")).toBeUndefined()
    expect(parseSpawnAttachMode("bogus")).toBeUndefined()
    expect(parseSpawnAttachMode(undefined)).toBeUndefined()
  })
})

describe("loadSpawnAttach — env > config > default", () => {
  const saved = process.env[SPAWN_ATTACH_ENV]
  beforeEach(() => {
    delete process.env[SPAWN_ATTACH_ENV]
  })
  afterEach(() => {
    if (saved === undefined) delete process.env[SPAWN_ATTACH_ENV]
    else process.env[SPAWN_ATTACH_ENV] = saved
  })
  it("defaults to always when nothing is configured", async () => {
    expect(await loadSpawnAttach(async () => ({}))).toBe(DEFAULT_SPAWN_ATTACH)
    expect(DEFAULT_SPAWN_ATTACH).toBe("always")
  })
  it("reads the config field when set", async () => {
    expect(await loadSpawnAttach(async () => ({ spawn: { attach: "on-request" } }))).toBe(
      "on-request",
    )
  })
  it("env overrides the config field", async () => {
    process.env[SPAWN_ATTACH_ENV] = "on-request"
    expect(await loadSpawnAttach(async () => ({ spawn: { attach: "always" } }))).toBe("on-request")
  })
  it("ignores a bogus env value and falls through to config", async () => {
    process.env[SPAWN_ATTACH_ENV] = "bogus"
    expect(await loadSpawnAttach(async () => ({ spawn: { attach: "on-request" } }))).toBe(
      "on-request",
    )
  })
  it("falls back to the default when the config loader throws", async () => {
    expect(
      await loadSpawnAttach(async () => {
        throw new Error("unreadable")
      }),
    ).toBe(DEFAULT_SPAWN_ATTACH)
  })
})

// Type-only guard: AttachField accepts the documented shapes.
const _shapes: AttachField[] = [true, false, { parent: "s1" }, {}]
void _shapes
