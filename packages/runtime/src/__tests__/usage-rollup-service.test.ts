/**
 * Focused coverage for `collectSessionSnapshots` — the impure disk-read +
 * descriptor-join shared by the `usage_rollup` MCP tool and `GET /usage/rollup`.
 *
 * The pure windowing/pricing math is owned by usage-rollup.test.ts; here we
 * only assert the collection contract: which sessions are included, how the
 * onlyIds/profileRef filters bite, and that the attribution keys are resolved
 * off the descriptor.
 */
import { describe, expect, it } from "vitest"
import type { SessionsRegistry } from "../sessions.js"
import type { UsageSnapshotRecord } from "../usage-rollup.js"
import { collectSessionSnapshots } from "../usage-rollup-service.js"

/** One cumulative snapshot — the fields the collector forwards verbatim. */
function snap(costUsd: number): UsageSnapshotRecord {
  return { ts: "2026-07-24T00:00:00.000Z", costUsd, tokensIn: 10, tokensOut: 5, source: "computed" }
}

type DescStub = {
  id: string
  kind: string
  accessProfile?: { profileRef: string }
  harness?: string
  adapterSlug?: string
}

/** Minimal registry exposing only `list()` + `readUsageSnapshots()`, the two
 *  methods `collectSessionSnapshots` touches. Cast through unknown so we don't
 *  have to satisfy the whole (large) SessionsRegistry surface. */
function fakeRegistry(
  descriptors: DescStub[],
  snapshots: Record<string, UsageSnapshotRecord[]>,
): SessionsRegistry {
  return {
    list: () => descriptors,
    readUsageSnapshots: async (id: string) => snapshots[id] ?? [],
  } as unknown as SessionsRegistry
}

describe("collectSessionSnapshots", () => {
  it("includes only agent-cli sessions that have ≥1 snapshot", async () => {
    const registry = fakeRegistry(
      [
        { id: "a", kind: "agent-cli", adapterSlug: "claude-code" },
        { id: "b", kind: "agent-cli", adapterSlug: "hermes" }, // no snapshots
        { id: "t", kind: "terminal" }, // wrong kind
        { id: "c", kind: "command" }, // wrong kind
      ],
      { a: [snap(1)], b: [], c: [snap(9)] },
    )
    const out = await collectSessionSnapshots(registry)
    expect(out.map(s => s.sessionId)).toEqual(["a"])
  })

  it("onlyIds filters to the subtree", async () => {
    const registry = fakeRegistry(
      [
        { id: "a", kind: "agent-cli", adapterSlug: "claude-code" },
        { id: "b", kind: "agent-cli", adapterSlug: "claude-code" },
        { id: "c", kind: "agent-cli", adapterSlug: "claude-code" },
      ],
      { a: [snap(1)], b: [snap(2)], c: [snap(3)] },
    )
    const out = await collectSessionSnapshots(registry, { onlyIds: new Set(["a", "c"]) })
    expect(out.map(s => s.sessionId).sort()).toEqual(["a", "c"])
  })

  it("profileRef keeps only sessions whose resolved profileRef matches", async () => {
    const registry = fakeRegistry(
      [
        { id: "a", kind: "agent-cli", accessProfile: { profileRef: "max" }, adapterSlug: "claude-code" },
        { id: "b", kind: "agent-cli", accessProfile: { profileRef: "team" }, adapterSlug: "claude-code" },
        { id: "c", kind: "agent-cli", adapterSlug: "claude-code" }, // no profile
      ],
      { a: [snap(1)], b: [snap(2)], c: [snap(3)] },
    )
    const out = await collectSessionSnapshots(registry, { profileRef: "max" })
    expect(out.map(s => s.sessionId)).toEqual(["a"])
  })

  it("resolves profileRef + harness off the descriptor (harness falls back to adapterSlug)", async () => {
    const registry = fakeRegistry(
      [
        // harness present → wins over adapterSlug
        { id: "a", kind: "agent-cli", accessProfile: { profileRef: "max" }, harness: "claude-code", adapterSlug: "cc-legacy" },
        // no harness → falls back to adapterSlug
        { id: "b", kind: "agent-cli", adapterSlug: "hermes" },
      ],
      { a: [snap(1)], b: [snap(2)] },
    )
    const out = await collectSessionSnapshots(registry)
    const a = out.find(s => s.sessionId === "a")
    const b = out.find(s => s.sessionId === "b")
    expect(a).toMatchObject({ profileRef: "max", harness: "claude-code" })
    expect(b).toMatchObject({ profileRef: undefined, harness: "hermes" })
  })

  it("tolerates a per-session read failure — treats it as no snapshots", async () => {
    const registry = {
      list: () => [
        { id: "a", kind: "agent-cli", adapterSlug: "claude-code" },
        { id: "boom", kind: "agent-cli", adapterSlug: "claude-code" },
      ],
      readUsageSnapshots: async (id: string) => {
        if (id === "boom") throw new Error("corrupt transcript")
        return [snap(1)]
      },
    } as unknown as SessionsRegistry
    const out = await collectSessionSnapshots(registry)
    expect(out.map(s => s.sessionId)).toEqual(["a"])
  })
})
