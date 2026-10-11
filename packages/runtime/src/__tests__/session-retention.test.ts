/**
 * On-disk session retention (`session-retention.ts`): which terminal session
 * dirs get deleted, and which never do.
 *
 * Hermetic: every test works in its own temp sessions dir (and the package
 * setup already points $HOME at a temp dir), so nothing here can touch the
 * real `~/.agentproto/sessions`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runSessionRetentionPass, type SessionRetentionRegistry } from "../session-retention.js"
import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { AgentSessionLike, AgentStreamEvent, SessionDescriptor } from "../sessions.js"

const DAY = 86_400_000
const NOW = Date.parse("2026-10-11T12:00:00.000Z")

let base: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "agp-retention-"))
  // Belt and braces: the pass must only ever see this temp dir.
  expect(base.startsWith(tmpdir())).toBe(true)
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

/** Write a session dir with an index.json + events.jsonl, every timestamp
 *  (sidecar fields AND file mtimes) set `ageDays` before NOW. */
function writeSessionDir(
  id: string,
  ageDays: number,
  fields: { origin?: string; label?: string; status?: string; alive?: boolean } = {},
): string {
  const dir = join(base, id)
  mkdirSync(dir, { recursive: true })
  const ts = new Date(NOW - ageDays * DAY)
  const entry = {
    id,
    kind: "agent-cli",
    status: fields.status ?? "killed",
    alive: fields.alive ?? false,
    startedAt: ts.toISOString(),
    lastActivityAt: ts.toISOString(),
    ...(fields.origin !== undefined ? { origin: fields.origin } : {}),
    ...(fields.label !== undefined ? { label: fields.label, title: fields.label } : {}),
  }
  writeFileSync(join(dir, "index.json"), JSON.stringify(entry))
  writeFileSync(join(dir, "events.jsonl"), '{"kind":"user-prompt","text":"hi"}\n')
  for (const p of [join(dir, "index.json"), join(dir, "events.jsonl"), dir]) utimesSync(p, ts, ts)
  return dir
}

function fakeRegistry(descs: Partial<SessionDescriptor>[] = []): SessionRetentionRegistry & { forgotten: string[] } {
  const rows = new Map(descs.map(d => [d.id as string, d as SessionDescriptor]))
  const forgotten: string[] = []
  return {
    forgotten,
    list: () => [...rows.values()],
    forgetSession(id) {
      const d = rows.get(id)
      if (!d) return "missing"
      if (d.status === "running" || d.status === "starting") return "alive"
      rows.delete(id)
      forgotten.push(id)
      return "forgotten"
    },
  }
}

function desc(id: string, ageDays: number, extra: Partial<SessionDescriptor> = {}): Partial<SessionDescriptor> {
  const ts = new Date(NOW - ageDays * DAY).toISOString()
  return { id, kind: "agent-cli", status: "killed", startedAt: ts, lastActivityAt: ts, ...extra }
}

describe("runSessionRetentionPass", () => {
  it("deletes a terminal review session past 7 days and keeps a fresh one", async () => {
    const old = writeSessionDir("sess_old", 8, { origin: "review", label: "review:x:correctness" })
    const fresh = writeSessionDir("sess_fresh", 2, { origin: "review", label: "review:x:correctness" })
    // A `review:` label alone (no origin) also counts as a review lane.
    const byLabel = writeSessionDir("sess_label", 9, { label: "review:agentik-studio:security", status: "error" })

    const res = await runSessionRetentionPass({ baseDir: base, registry: fakeRegistry(), now: () => NOW })

    expect(res.enabled).toBe(true)
    expect(res.reviewMaxAgeDays).toBe(7)
    expect(res.maxAgeDays).toBeNull()
    expect(res.ids.sort()).toEqual(["sess_label", "sess_old"])
    expect(res.count).toBe(2)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(byLabel)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it("keeps non-review sessions by default, deletes them once maxAgeDays is set", async () => {
    const regular = writeSessionDir("sess_regular", 400, { status: "exited" })

    const byDefault = await runSessionRetentionPass({ baseDir: base, registry: fakeRegistry(), now: () => NOW })
    expect(byDefault.count).toBe(0)
    expect(byDefault.kept.noRule).toBe(1)
    expect(existsSync(regular)).toBe(true)

    const configured = await runSessionRetentionPass({
      baseDir: base,
      registry: fakeRegistry(),
      maxAgeDays: 90,
      now: () => NOW,
    })
    expect(configured.ids).toEqual(["sess_regular"])
    expect(existsSync(regular)).toBe(false)
  })

  it("never deletes an alive, pinned, keepAlive session or an ancestor of a live one", async () => {
    for (const id of ["sess_alive", "sess_pinned", "sess_keep", "sess_parent", "sess_grandparent"]) {
      writeSessionDir(id, 30, { origin: "review" })
    }
    const registry = fakeRegistry([
      desc("sess_alive", 30, { status: "running", origin: "review" }),
      desc("sess_pinned", 30, { pinned: true, origin: "review" }),
      desc("sess_keep", 30, { keepAlive: true, origin: "review" }),
      desc("sess_grandparent", 30, { origin: "review" }),
      desc("sess_parent", 30, { origin: "review", parentSessionId: "sess_grandparent" }),
      desc("sess_child", 0, { status: "running", parentSessionId: "sess_parent" }),
    ])

    const res = await runSessionRetentionPass({
      baseDir: base,
      registry,
      maxAgeDays: 1,
      now: () => NOW,
    })

    expect(res.count).toBe(0)
    expect(res.kept.protected).toBe(5)
    expect(registry.forgotten).toEqual([])
    for (const id of ["sess_alive", "sess_pinned", "sess_keep", "sess_parent", "sess_grandparent"]) {
      expect(existsSync(join(base, id))).toBe(true)
    }
  })

  it("keeps a dir whose transcript was written recently even if its sidecar is old", async () => {
    const dir = writeSessionDir("sess_stale_index", 30, { origin: "review" })
    const recent = new Date(NOW - 60_000)
    utimesSync(join(dir, "events.jsonl"), recent, recent)

    const res = await runSessionRetentionPass({ baseDir: base, registry: fakeRegistry(), now: () => NOW })
    expect(res.count).toBe(0)
    expect(res.kept.tooRecent).toBe(1)
    expect(existsSync(dir)).toBe(true)
  })

  it("dryRun reports candidates but deletes nothing and forgets nothing", async () => {
    const dir = writeSessionDir("sess_review", 10, { origin: "review" })
    const registry = fakeRegistry([desc("sess_review", 10, { origin: "review" })])

    const res = await runSessionRetentionPass({ baseDir: base, registry, dryRun: true, now: () => NOW })

    expect(res.dryRun).toBe(true)
    expect(res.ids).toEqual(["sess_review"])
    expect(res.count).toBe(1)
    expect(existsSync(dir)).toBe(true)
    expect(registry.forgotten).toEqual([])
  })

  it("drops a registry-held session through forgetSession before removing its dir", async () => {
    const dir = writeSessionDir("sess_held", 10, { origin: "review" })
    const registry = fakeRegistry([desc("sess_held", 10, { origin: "review" })])

    const res = await runSessionRetentionPass({ baseDir: base, registry, now: () => NOW })

    expect(res.ids).toEqual(["sess_held"])
    expect(registry.forgotten).toEqual(["sess_held"])
    expect(existsSync(dir)).toBe(false)
  })

  it("is disabled when both thresholds are off", async () => {
    const dir = writeSessionDir("sess_review", 100, { origin: "review" })
    const res = await runSessionRetentionPass({
      baseDir: base,
      registry: fakeRegistry(),
      reviewMaxAgeDays: 0,
      now: () => NOW,
    })
    expect(res.enabled).toBe(false)
    expect(res.scanned).toBe(0)
    expect(existsSync(dir)).toBe(true)
  })

  it("respects onlyIds scoping", async () => {
    writeSessionDir("sess_a", 10, { origin: "review" })
    const b = writeSessionDir("sess_b", 10, { origin: "review" })
    const res = await runSessionRetentionPass({
      baseDir: base,
      registry: fakeRegistry(),
      onlyIds: new Set(["sess_a"]),
      now: () => NOW,
    })
    expect(res.ids).toEqual(["sess_a"])
    expect(existsSync(b)).toBe(true)
  })
})

describe("SessionsRegistry retention wiring", () => {
  let n = 0
  function fakeAgentSession(): AgentSessionLike {
    return {
      sessionId: `c_${n++}`,
      // eslint-disable-next-line require-yield
      async *send(): AsyncIterable<AgentStreamEvent> {
        return
      },
      async cancel() {},
      async close() {},
    }
  }

  it("forgets + deletes a dead review session and keeps the live one", async () => {
    const registry = createSessionsRegistry({
      sessionEvents: createSessionEventBus(),
      persist: false,
      transcriptDir: base,
    })
    const spawn = (): string =>
      registry.spawnAgent({
        workspaceSlug: "default",
        cwd: process.cwd(),
        agentSession: fakeAgentSession(),
        adapterSlug: "claude-code",
        origin: "review",
        label: "review:test:lane",
      }).id
    const dead = spawn()
    const live = spawn()
    registry.kill(dead)
    mkdirSync(join(base, dead), { recursive: true })
    mkdirSync(join(base, live), { recursive: true })

    expect(registry.forgetSession(live)).toBe("alive")
    expect(registry.forgetSession("sess_nope")).toBe("missing")

    // A clock 30 days ahead makes every timestamp (and mtime) "old".
    const res = await runSessionRetentionPass({
      baseDir: base,
      registry,
      now: () => Date.now() + 30 * DAY,
    })

    expect(res.ids).toEqual([dead])
    expect(registry.get(dead)).toBeUndefined()
    expect(existsSync(join(base, dead))).toBe(false)
    expect(registry.get(live)).toBeDefined()
    expect(existsSync(join(base, live))).toBe(true)
    registry.shutdown()
  })

  it("pruneSessionDirs honours the configured defaults", async () => {
    const registry = createSessionsRegistry({
      sessionEvents: createSessionEventBus(),
      persist: false,
      transcriptDir: base,
      sessionRetention: { reviewMaxAgeDays: null, maxAgeDays: 3 },
    })
    const res = await registry.pruneSessionDirs({ dryRun: true })
    expect(res.reviewMaxAgeDays).toBeNull()
    expect(res.maxAgeDays).toBe(3)
    const overridden = await registry.pruneSessionDirs({ dryRun: true, maxAgeDays: null })
    expect(overridden.enabled).toBe(false)
    registry.shutdown()
  })
})

describe("backfillSessionIndexesAsync", () => {
  it("matches the sync backfill: creates missing sidecars, skips valid ones", async () => {
    const { backfillSessionIndexesAsync, readSessionIndex } = await import("../session-index.js")
    writeSessionDir("sess_has_index", 1, { origin: "review" })
    const bare = join(base, "sess_no_index")
    mkdirSync(bare)
    writeFileSync(
      join(bare, "events.jsonl"),
      JSON.stringify({ kind: "user-prompt", text: "hello", ts: new Date(NOW).toISOString() }) + "\n",
    )
    mkdirSync(join(base, "sess_empty"))

    const res = await backfillSessionIndexesAsync(base)
    expect(res).toEqual({ scanned: 3, created: 1, skipped: 2 })
    expect(readSessionIndex("sess_no_index", base)?.id).toBe("sess_no_index")
  })
})
