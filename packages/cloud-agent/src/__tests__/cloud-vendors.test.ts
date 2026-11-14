/**
 * AIP-66 managed cloud agents - the vendor registry, the pure spawn
 * resolver (`resolveCloudSpawn`), the `meta.cloud` mapping helpers, the
 * relay's session-meta side file and watch, and the resume-side vendor id
 * fallback. No network, no runtime: only this package's public surface.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  CLOUD_ADAPTER_PLACEHOLDER,
  CLOUD_SESSION_META_FILE_ENV,
  CLOUD_VENDORS,
  CloudSpawnError,
  CLOUD_REFUSED_SPAWN_FIELDS,
  cloudMetaOf,
  cloudSessionIdOf,
  cloudSessionMetaFilePath,
  decodeCloudSessionMeta,
  encodeCloudSessionMeta,
  readCloudSessionMetaFile,
  resolveCloudResumeId,
  resolveCloudSpawn,
  watchCloudSessionMeta,
  type CloudSpawnInput,
} from "../index.js"

// ── resolveCloudSpawn (pure) ────────────────────────────────────────────────

describe("resolveCloudSpawn - refusals", () => {
  it("refuses an unknown vendor slug - never mapped to a default", () => {
    expect(() => resolveCloudSpawn({ cloud: "openai" })).toThrow(CloudSpawnError)
    try {
      resolveCloudSpawn({ cloud: "bogus" })
    } catch (err) {
      expect(err).toBeInstanceOf(CloudSpawnError)
      expect((err as CloudSpawnError).code).toBe("cloud_spawn_refused")
      expect((err as CloudSpawnError).message).toContain("unknown cloud vendor")
      expect((err as CloudSpawnError).message).toContain("bogus")
      expect((err as CloudSpawnError).message).toContain(Object.keys(CLOUD_VENDORS).join(", "))
    }
  })

  it("refuses cloud + sandbox (mutually exclusive, AIP-66 §1)", () => {
    try {
      resolveCloudSpawn({ cloud: "anthropic", sandbox: {} })
      throw new Error("expected a refusal")
    } catch (err) {
      expect(err).toBeInstanceOf(CloudSpawnError)
      expect((err as CloudSpawnError).field).toBe("sandbox")
      expect((err as CloudSpawnError).message).toContain("mutually exclusive")
    }
  })

  for (const field of CLOUD_REFUSED_SPAWN_FIELDS) {
    if (field === "sandbox") continue // covered above (its own message)
    it(`refuses \`${field}\` by name (AIP-66 §4)`, () => {
      const value: Record<string, unknown> = {
        cloud: "anthropic",
        [field]:
          field === "commandSandbox"
            ? "strict"
            : field === "daemonMount"
              ? true
              : field === "browser"
                ? "chrome"
                : field === "mcpServers" || field === "bundles"
                  ? [{ name: "x" }]
                  : { any: "non-empty" },
      }
      try {
        resolveCloudSpawn(value as unknown as CloudSpawnInput)
        throw new Error("expected a refusal")
      } catch (err) {
        expect(err).toBeInstanceOf(CloudSpawnError)
        expect((err as CloudSpawnError).field).toBe(field)
        expect((err as CloudSpawnError).code).toBe("cloud_spawn_refused")
        expect((err as CloudSpawnError).message).toContain(`\`${field}\``)
      }
    })
  }

  it("accepts the §4 fields in their no-op spellings (false / off / empty)", () => {
    const resolved = resolveCloudSpawn({
      cloud: "anthropic",
      worktree: false,
      commandSandbox: "off",
      mcpServers: [],
      daemonMount: false,
      bundles: [],
      browser: false,
    })
    expect(resolved.adapter).toBe("claude-code-cloud")
  })

  it("refuses a harness the vendor does not run - naming the allowed ones", () => {
    try {
      resolveCloudSpawn({ cloud: "anthropic", harness: "codex" })
      throw new Error("expected a refusal")
    } catch (err) {
      expect(err).toBeInstanceOf(CloudSpawnError)
      expect((err as CloudSpawnError).message).toContain("codex")
      expect((err as CloudSpawnError).message).toContain("anthropic")
      // The allowed harnesses are named in the error (AIP-66 §2).
      expect((err as CloudSpawnError).message).toContain("claude-code")
      expect((err as CloudSpawnError).message).toContain("claude-code-cloud")
    }
    expect(() => resolveCloudSpawn({ cloud: "anthropic", adapter: "hermes" })).toThrow(
      CloudSpawnError,
    )
  })
})

describe("resolveCloudSpawn - resolution", () => {
  it("adapter claude-code → relay adapter claude-code-cloud, harness claude-code", () => {
    expect(resolveCloudSpawn({ cloud: "anthropic", adapter: "claude-code" })).toEqual({
      vendor: CLOUD_VENDORS["anthropic"],
      adapter: "claude-code-cloud",
      harness: "claude-code",
    })
  })

  it("harness claude-code → the same resolution", () => {
    expect(resolveCloudSpawn({ cloud: "anthropic", harness: "claude-code" })).toEqual({
      vendor: CLOUD_VENDORS["anthropic"],
      adapter: "claude-code-cloud",
      harness: "claude-code",
    })
  })

  it("unset adapter/harness → the vendor's relay adapter, vendor's harness", () => {
    expect(resolveCloudSpawn({ cloud: "anthropic" })).toEqual({
      vendor: CLOUD_VENDORS["anthropic"],
      adapter: "claude-code-cloud",
      harness: "claude-code",
    })
  })

  it("records the vendor's HARNESS, not the local relay adapter slug (AIP-66 §2)", () => {
    // `adapter` is the local relay ("claude-code-cloud"); the descriptor's
    // `harness` must be the VENDOR's harness ("claude-code") - even when the
    // requested adapter IS the relay adapter.
    const fromUnset = resolveCloudSpawn({ cloud: "anthropic" })
    expect(fromUnset.adapter).toBe("claude-code-cloud")
    expect(fromUnset.harness).toBe("claude-code")
    const fromRelayAdapter = resolveCloudSpawn({
      cloud: "anthropic",
      adapter: "claude-code-cloud",
    })
    expect(fromRelayAdapter.adapter).toBe("claude-code-cloud")
    expect(fromRelayAdapter.harness).toBe("claude-code")
  })

  it("the spawn surfaces' placeholder adapter resolves exactly like an unset adapter", () => {
    // The MCP/HTTP surfaces' input types require an `adapter` string even
    // when `cloud` is set and nothing chose one - they pass
    // CLOUD_ADAPTER_PLACEHOLDER, which must never be refused as an unknown
    // harness.
    expect(resolveCloudSpawn({ cloud: "anthropic", adapter: CLOUD_ADAPTER_PLACEHOLDER })).toEqual({
      vendor: CLOUD_VENDORS["anthropic"],
      adapter: "claude-code-cloud",
      harness: "claude-code",
    })
  })

  it("the relay adapter itself is accepted as the requested adapter", () => {
    expect(resolveCloudSpawn({ cloud: "anthropic", adapter: "claude-code-cloud" })).toEqual({
      vendor: CLOUD_VENDORS["anthropic"],
      adapter: "claude-code-cloud",
      harness: "claude-code",
    })
  })
})

// ── meta.cloud mapping (AIP-66 §5) ─────────────────────────────────────────

describe("meta.cloud encode/decode", () => {
  it("round-trips a mapping through the string-valued descriptor meta", () => {
    const encoded = encodeCloudSessionMeta({
      vendor: "anthropic",
      sessionId: "session_01Fake",
      url: "https://claude.ai/code/session_01Fake",
    })
    expect(typeof encoded).toBe("string") // SessionDescriptor.meta is Record<string,string>
    expect(decodeCloudSessionMeta(encoded)).toEqual({
      vendor: "anthropic",
      sessionId: "session_01Fake",
      url: "https://claude.ai/code/session_01Fake",
    })
  })

  it("decodes a vendor-only mapping and tolerates an already-parsed object", () => {
    expect(decodeCloudSessionMeta(encodeCloudSessionMeta({ vendor: "anthropic" }))).toEqual({
      vendor: "anthropic",
    })
    expect(decodeCloudSessionMeta({ vendor: "anthropic", sessionId: "session_x" })).toEqual({
      vendor: "anthropic",
      sessionId: "session_x",
    })
  })

  it("returns undefined for absent/garbage/credential-shaped values - never throws", () => {
    expect(decodeCloudSessionMeta(undefined)).toBeUndefined()
    expect(decodeCloudSessionMeta("")).toBeUndefined()
    expect(decodeCloudSessionMeta("{not json")).toBeUndefined()
    expect(decodeCloudSessionMeta("[1,2]")).toBeUndefined()
    expect(decodeCloudSessionMeta({ vendor: "" })).toBeUndefined()
    expect(decodeCloudSessionMeta({ noVendor: true })).toBeUndefined()
    // An empty sessionId is dropped rather than persisted as "".
    expect(decodeCloudSessionMeta({ vendor: "anthropic", sessionId: "" })).toEqual({
      vendor: "anthropic",
    })
  })

  it("cloudMetaOf / cloudSessionIdOf read the descriptor's meta.cloud", () => {
    const desc = {
      meta: {
        cloud: encodeCloudSessionMeta({
          vendor: "anthropic",
          sessionId: "session_learned",
          url: "https://claude.ai/code/session_learned",
        }),
      },
    }
    expect(cloudMetaOf(desc)?.sessionId).toBe("session_learned")
    expect(cloudSessionIdOf(desc)).toBe("session_learned")
    expect(cloudSessionIdOf({ meta: {} })).toBeUndefined()
    expect(cloudSessionIdOf(undefined)).toBeUndefined()
  })

  it("never carries a credential-shaped field through the mapping", () => {
    const decoded = decodeCloudSessionMeta(
      encodeCloudSessionMeta({
        vendor: "anthropic",
        sessionId: "session_01Fake",
        url: "https://claude.ai/code/session_01Fake",
      }),
    )
    expect(Object.keys(decoded ?? {}).sort()).toEqual(["sessionId", "url", "vendor"])
  })
})

// ── the relay's meta side file (AIP-66 §5/§8) ──────────────────────────────

describe("readCloudSessionMetaFile / watchCloudSessionMeta", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agp-cloud-meta-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("returns null for absent / unparseable / incomplete files - never throws", async () => {
    expect(await readCloudSessionMetaFile(join(dir, "missing.json"))).toBeNull()
    const garbage = join(dir, "garbage.json")
    await writeFile(garbage, "{oops", "utf8")
    expect(await readCloudSessionMetaFile(garbage)).toBeNull()
    const noId = join(dir, "noid.json")
    await writeFile(noId, JSON.stringify({ vendor: "anthropic" }), "utf8")
    expect(await readCloudSessionMetaFile(noId)).toBeNull()
  })

  it("reads a well-formed relay file (vendor + sessionId + url)", async () => {
    const path = join(dir, "cloud-session.json")
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        vendor: "anthropic",
        sessionId: "session_01Fake",
        url: "https://claude.ai/code/session_01Fake",
      }),
      "utf8",
    )
    expect(await readCloudSessionMetaFile(path)).toEqual({
      vendor: "anthropic",
      sessionId: "session_01Fake",
      url: "https://claude.ai/code/session_01Fake",
    })
  })

  it("watchCloudSessionMeta calls onLearned exactly once when the file appears", async () => {
    const path = join(dir, "cloud-session.json")
    const onLearned = vi.fn()
    const stop = watchCloudSessionMeta({
      metaFilePath: path,
      vendor: "anthropic",
      onLearned,
      intervalMs: 1,
      timeoutMs: 2_000,
    })
    try {
      // No file yet - the poll keeps watching, never learning.
      await new Promise(resolve => setTimeout(resolve, 15))
      expect(onLearned).not.toHaveBeenCalled()

      // The relay writes the file; the next tick learns it and stops.
      await mkdir(dirname(path), { recursive: true })
      await writeFile(
        path,
        JSON.stringify({ vendor: "anthropic", sessionId: "session_learned" }),
        "utf8",
      )
      await vi.waitFor(() => expect(onLearned).toHaveBeenCalledTimes(1))
      expect(onLearned).toHaveBeenCalledWith({
        vendor: "anthropic",
        sessionId: "session_learned",
      })
      // No further callback after learning.
      await new Promise(resolve => setTimeout(resolve, 15))
      expect(onLearned).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
  })

  it("watchCloudSessionMeta ignores a meta file written for another vendor and keeps watching", async () => {
    const path = join(dir, "cloud-session.json")
    const onLearned = vi.fn()
    const stop = watchCloudSessionMeta({
      metaFilePath: path,
      vendor: "anthropic",
      onLearned,
      intervalMs: 1,
      timeoutMs: 2_000,
    })
    try {
      // A file naming a DIFFERENT vendor is not this watch's to learn - the
      // vendor option is not dead: the poll keeps watching.
      await mkdir(dirname(path), { recursive: true })
      await writeFile(
        path,
        JSON.stringify({ vendor: "openai", sessionId: "session_other" }),
        "utf8",
      )
      await new Promise(resolve => setTimeout(resolve, 25))
      expect(onLearned).not.toHaveBeenCalled()

      // It was still watching: once the file names THIS vendor, it learns.
      await writeFile(
        path,
        JSON.stringify({ vendor: "anthropic", sessionId: "session_mine" }),
        "utf8",
      )
      await vi.waitFor(() => expect(onLearned).toHaveBeenCalledTimes(1))
      expect(onLearned).toHaveBeenCalledWith({
        vendor: "anthropic",
        sessionId: "session_mine",
      })
    } finally {
      stop()
    }
  })

  it("watchCloudSessionMeta stops when shouldContinue turns false (session died)", async () => {
    const path = join(dir, "cloud-session.json")
    const onLearned = vi.fn()
    const stop = watchCloudSessionMeta({
      metaFilePath: path,
      vendor: "anthropic",
      onLearned,
      shouldContinue: () => false,
      intervalMs: 1,
      timeoutMs: 2_000,
    })
    try {
      // The session is dead on the first tick: the watch stops WITHOUT
      // reading - even after the file appears, nothing is learned.
      await mkdir(dirname(path), { recursive: true })
      await writeFile(
        path,
        JSON.stringify({ vendor: "anthropic", sessionId: "session_late" }),
        "utf8",
      )
      await new Promise(resolve => setTimeout(resolve, 15))
      expect(onLearned).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })

  it("with no timeoutMs the watch keeps watching past the old 10-minute cap - an idle-spawned session still learns hours later", async () => {
    const path = join(dir, "cloud-session.json")
    const onLearned = vi.fn()
    // Virtual clock: the watch's only deadline check is `Date.now() - start
    // >= timeoutMs`; spying on Date.now lets us jump past the old 10-minute
    // default without waiting for it, while the poll itself stays real.
    const realNow = Date.now.bind(Date)
    let offsetMs = 0
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs)
    let alive = true
    const stop = watchCloudSessionMeta({
      metaFilePath: path,
      vendor: "anthropic",
      onLearned,
      shouldContinue: () => alive,
      intervalMs: 5,
      // No timeoutMs: the default must be "no fixed timeout" - the watch
      // lives exactly as long as the session (shouldContinue).
    })
    try {
      // No file yet - the poll keeps watching, never learning.
      await new Promise(resolve => setTimeout(resolve, 40))
      expect(onLearned).not.toHaveBeenCalled()

      // Jump way past the old 10-minute default cap; the watch survives
      // (a 10-minute timeout would have stopped it at the next tick).
      offsetMs += 30 * 60_000
      await new Promise(resolve => setTimeout(resolve, 40))
      expect(onLearned).not.toHaveBeenCalled()

      // The session is STILL alive and the relay finally writes the file -
      // the watch learns it 30 virtual minutes after spawn.
      await mkdir(dirname(path), { recursive: true })
      await writeFile(
        path,
        JSON.stringify({ vendor: "anthropic", sessionId: "session_idle_later" }),
        "utf8",
      )
      await vi.waitFor(() => expect(onLearned).toHaveBeenCalledTimes(1))
      expect(onLearned).toHaveBeenCalledWith({
        vendor: "anthropic",
        sessionId: "session_idle_later",
      })
    } finally {
      alive = false
      nowSpy.mockRestore()
      stop()
    }
  })

  it("an explicit timeoutMs still caps the watch (test seam)", async () => {
    const path = join(dir, "cloud-session.json")
    const onLearned = vi.fn()
    const realNow = Date.now.bind(Date)
    let offsetMs = 0
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs)
    const stop = watchCloudSessionMeta({
      metaFilePath: path,
      vendor: "anthropic",
      onLearned,
      intervalMs: 5,
      timeoutMs: 30,
    })
    try {
      // Past the explicit cap: the watch stops WITHOUT learning, even once
      // the file appears afterwards.
      offsetMs += 10 * 60_000
      await new Promise(resolve => setTimeout(resolve, 40))
      await mkdir(dirname(path), { recursive: true })
      await writeFile(
        path,
        JSON.stringify({ vendor: "anthropic", sessionId: "session_too_late" }),
        "utf8",
      )
      await new Promise(resolve => setTimeout(resolve, 40))
      expect(onLearned).not.toHaveBeenCalled()
    } finally {
      nowSpy.mockRestore()
      stop()
    }
  })
})

// ── resolveCloudResumeId - the resume-side fallback (AIP-66 §5) ────────────

describe("resolveCloudResumeId", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agp-cloud-resume-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("prefers the learned meta.cloud.sessionId - no side-file read, no merge", async () => {
    const merge = vi.fn()
    const id = await resolveCloudResumeId(
      {
        id: "sess_learned",
        meta: { cloud: encodeCloudSessionMeta({ vendor: "anthropic", sessionId: "session_learned" }) },
        adapterConfigDir: dir,
      },
      merge,
    )
    expect(id).toBe("session_learned")
    expect(merge).not.toHaveBeenCalled()
  })

  it("falls back to the relay's meta file in the row's config dir and merge-stamps the mapping", async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(
      cloudSessionMetaFilePath(dir),
      JSON.stringify({
        vendor: "anthropic",
        sessionId: "session_from_file",
        url: "https://claude.ai/code/session_from_file",
      }),
      "utf8",
    )
    const merge = vi.fn()
    const id = await resolveCloudResumeId(
      {
        // Vendor binding learned at spawn; the id never stamped (watch killed
        // by a daemon restart before the first prompt).
        id: "sess_row",
        meta: { cloud: encodeCloudSessionMeta({ vendor: "anthropic" }) },
        adapterConfigDir: dir,
      },
      merge,
    )
    expect(id).toBe("session_from_file")
    // The caller stamps the full mapping back onto the descriptor.
    expect(merge).toHaveBeenCalledWith({
      vendor: "anthropic",
      sessionId: "session_from_file",
      url: "https://claude.ai/code/session_from_file",
    })
  })

  it("returns undefined (never merging) for a missing/garbage file, no config dir, or a non-cloud row", async () => {
    const merge = vi.fn()
    const cloudRowNoFile = {
      id: "sess_a",
      meta: { cloud: encodeCloudSessionMeta({ vendor: "anthropic" }) },
      adapterConfigDir: dir,
    }
    expect(await resolveCloudResumeId(cloudRowNoFile, merge)).toBeUndefined()

    await writeFile(cloudSessionMetaFilePath(dir), "{oops", "utf8")
    expect(await resolveCloudResumeId(cloudRowNoFile, merge)).toBeUndefined()

    expect(
      await resolveCloudResumeId(
        {
          id: "sess_b",
          meta: { cloud: encodeCloudSessionMeta({ vendor: "anthropic" }) },
          // No isolated config dir → nothing to probe.
        },
        merge,
      ),
    ).toBeUndefined()

    // A NON-cloud row never probes the side file, even with a config dir.
    await writeFile(
      cloudSessionMetaFilePath(dir),
      JSON.stringify({ vendor: "anthropic", sessionId: "session_never" }),
      "utf8",
    )
    expect(await resolveCloudResumeId({ id: "sess_c", adapterConfigDir: dir }, merge)).toBeUndefined()
    expect(await resolveCloudResumeId(undefined, merge)).toBeUndefined()
    expect(merge).not.toHaveBeenCalled()
  })
})
