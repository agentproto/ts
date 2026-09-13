/**
 * The policy layer for `agent_start`'s implicit-dedupe default — the pure
 * key derivation (`deriveImplicitIdempotencyKey`) and the env/config
 * resolver (`loadSpawnDedupe`). No daemon, no filesystem: the resolver
 * takes an injected config loader so it never reads the real
 * `~/.agentproto/config.json`. The side-effecting half (claiming/matching
 * through `spawnAgentSession`) is covered against the spawn path in
 * session-spawn's own suite.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  DEFAULT_SPAWN_DEDUPE,
  deriveImplicitIdempotencyKey,
  loadSpawnDedupe,
  parseSpawnDedupeMode,
  SPAWN_DEDUPE_ENV,
} from "../spawn-dedupe.js"

describe("deriveImplicitIdempotencyKey", () => {
  it("returns undefined with no label — the fan-out safety boundary", () => {
    expect(deriveImplicitIdempotencyKey({})).toBeUndefined()
    expect(deriveImplicitIdempotencyKey({ prompt: "do the thing" })).toBeUndefined()
  })

  it("returns undefined for a blank/whitespace-only label", () => {
    expect(deriveImplicitIdempotencyKey({ label: "" })).toBeUndefined()
    expect(deriveImplicitIdempotencyKey({ label: "   " })).toBeUndefined()
  })

  it("derives a key from a present label, with or without a prompt", () => {
    expect(deriveImplicitIdempotencyKey({ label: "worker" })).toBeDefined()
    expect(deriveImplicitIdempotencyKey({ label: "worker", prompt: "hi" })).toBeDefined()
  })

  it("is deterministic — same label+prompt always derives the same key", () => {
    const a = deriveImplicitIdempotencyKey({ label: "worker", prompt: "do the thing" })
    const b = deriveImplicitIdempotencyKey({ label: "worker", prompt: "do the thing" })
    expect(a).toBe(b)
  })

  it("a different prompt under the SAME label derives a DIFFERENT key", () => {
    const a = deriveImplicitIdempotencyKey({ label: "worker", prompt: "message 1" })
    const b = deriveImplicitIdempotencyKey({ label: "worker", prompt: "message 2" })
    expect(a).not.toBe(b)
  })

  it("a different label under the same prompt derives a DIFFERENT key", () => {
    const a = deriveImplicitIdempotencyKey({ label: "worker-a", prompt: "hi" })
    const b = deriveImplicitIdempotencyKey({ label: "worker-b", prompt: "hi" })
    expect(a).not.toBe(b)
  })

  it("trims the label before deriving — leading/trailing whitespace doesn't change the key", () => {
    const a = deriveImplicitIdempotencyKey({ label: "worker" })
    const b = deriveImplicitIdempotencyKey({ label: "  worker  " })
    expect(a).toBe(b)
  })

  it("an absent prompt and an empty-string prompt derive the SAME key", () => {
    const a = deriveImplicitIdempotencyKey({ label: "worker" })
    const b = deriveImplicitIdempotencyKey({ label: "worker", prompt: "" })
    expect(a).toBe(b)
  })
})

describe("parseSpawnDedupeMode", () => {
  it("accepts the two valid modes", () => {
    expect(parseSpawnDedupeMode("always")).toBe("always")
    expect(parseSpawnDedupeMode("on-request")).toBe("on-request")
  })
  it("rejects anything else", () => {
    expect(parseSpawnDedupeMode("never")).toBeUndefined()
    expect(parseSpawnDedupeMode("bogus")).toBeUndefined()
    expect(parseSpawnDedupeMode(undefined)).toBeUndefined()
  })
})

describe("loadSpawnDedupe — env > config > default", () => {
  const saved = process.env[SPAWN_DEDUPE_ENV]
  beforeEach(() => {
    delete process.env[SPAWN_DEDUPE_ENV]
  })
  afterEach(() => {
    if (saved === undefined) delete process.env[SPAWN_DEDUPE_ENV]
    else process.env[SPAWN_DEDUPE_ENV] = saved
  })
  it("defaults to always when nothing is configured", async () => {
    expect(await loadSpawnDedupe(async () => ({}))).toBe(DEFAULT_SPAWN_DEDUPE)
    expect(DEFAULT_SPAWN_DEDUPE).toBe("always")
  })
  it("reads the config field when set", async () => {
    expect(await loadSpawnDedupe(async () => ({ spawn: { dedupe: "on-request" } }))).toBe(
      "on-request",
    )
  })
  it("env overrides the config field", async () => {
    process.env[SPAWN_DEDUPE_ENV] = "on-request"
    expect(await loadSpawnDedupe(async () => ({ spawn: { dedupe: "always" } }))).toBe(
      "on-request",
    )
  })
  it("ignores a bogus env value and falls through to config", async () => {
    process.env[SPAWN_DEDUPE_ENV] = "bogus"
    expect(await loadSpawnDedupe(async () => ({ spawn: { dedupe: "on-request" } }))).toBe(
      "on-request",
    )
  })
  it("falls back to the default when the config loader throws", async () => {
    expect(
      await loadSpawnDedupe(async () => {
        throw new Error("unreadable")
      }),
    ).toBe(DEFAULT_SPAWN_DEDUPE)
  })
})
