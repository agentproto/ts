import { describe, it, expect } from "vitest"

import {
  deriveEffectiveGrants,
  resolveOperatorDelegates,
  type EffectiveGrantsInput,
} from "../effective-grants.js"
import { DEFAULT_MESSAGING_DEFAULTS } from "../messaging-defaults.js"

const DEFAULTS: EffectiveGrantsInput["messaging"] = {
  allowSiblings: DEFAULT_MESSAGING_DEFAULTS.allowSiblings,
  allowSameWorkspace: DEFAULT_MESSAGING_DEFAULTS.allowSameWorkspace,
  peerGroups: DEFAULT_MESSAGING_DEFAULTS.peerGroups,
  peerBinding: DEFAULT_MESSAGING_DEFAULTS.peerBinding,
}

function input(overrides: Partial<EffectiveGrantsInput> = {}): EffectiveGrantsInput {
  return {
    messaging: DEFAULTS,
    operatorDelegates: [],
    sessions: [],
    ...overrides,
  }
}

describe("deriveEffectiveGrants", () => {
  it("reports exactly one same-workspace grant for the defaults", () => {
    const report = deriveEffectiveGrants(input())
    expect(report.grants).toHaveLength(1)
    expect(report.grants[0]).toMatchObject({
      source: "defaults.messaging.allowSameWorkspace",
      exact: false,
      portable: true,
      pair: "same-workspace",
    })
    expect(report.unmapped).toEqual([])
  })

  it("adds a sibling grant with an unscoped session:message action when allowSiblings is on", () => {
    const report = deriveEffectiveGrants(
      input({ messaging: { ...DEFAULTS, allowSiblings: true } }),
    )
    const sibling = report.grants.find(g => g.source === "defaults.messaging.allowSiblings")
    expect(sibling).toBeDefined()
    expect(sibling?.pair).toBe("sibling")
    expect(sibling?.grant.actions).toEqual([{ action: "session:message" }])
  })

  it("reports one grant per peer-group slug, each note naming its group index", () => {
    const report = deriveEffectiveGrants(
      input({
        messaging: {
          ...DEFAULTS,
          allowSiblings: false,
          allowSameWorkspace: false,
          peerGroups: [["a", "b"], ["c"]],
        },
      }),
    )
    expect(report.grants).toHaveLength(3)
    expect(report.grants.map(g => g.grant.actions[0]?.scope)).toEqual([
      "workspace:a",
      "workspace:b",
      "workspace:c",
    ])
    expect(report.grants[0]?.note).toContain("Group 0")
    expect(report.grants[1]?.note).toContain("Group 0")
    expect(report.grants[2]?.note).toContain("Group 1")
  })

  it("changes the same-workspace note when peerBinding is verified", () => {
    const slug = deriveEffectiveGrants(input())
    const verified = deriveEffectiveGrants(
      input({ messaging: { ...DEFAULTS, peerBinding: "verified" } }),
    )
    expect(slug.grants[0]?.note).not.toContain("verified")
    expect(verified.grants[0]?.note).toContain("verified")
  })

  it("derives one prompt/control grant from an allowPromptFrom label entry", () => {
    const report = deriveEffectiveGrants(
      input({
        sessions: [
          {
            id: "s1",
            operatorLabel: "brain",
            allowPromptFrom: ["label:pygmalion-brain-persistent"],
          },
        ],
      }),
    )
    const grants = report.grants.filter(g => g.source === "session.allowPromptFrom")
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({
      grant: {
        principal: "session-label://pygmalion-brain-persistent",
        effect: "allow",
        actions: [
          { action: "session:prompt", scope: "label:brain" },
          { action: "session:control", scope: "label:brain" },
        ],
      },
      exact: false,
      portable: true,
      sessionId: "s1",
    })
  })

  it("scopes by session id and marks the grant non-portable without an operator label", () => {
    const report = deriveEffectiveGrants(
      input({
        sessions: [{ id: "s1", allowPromptFrom: ["label:ops"] }],
      }),
    )
    const grant = report.grants.find(g => g.source === "session.allowPromptFrom")
    expect(grant?.grant.actions).toEqual([
      { action: "session:prompt", scope: "s1" },
      { action: "session:control", scope: "s1" },
    ])
    expect(grant?.portable).toBe(false)
  })

  it("maps any, reports label prefixes as unmapped, and reports unusable entries as unmapped", () => {
    const any = deriveEffectiveGrants(
      input({ sessions: [{ id: "s1", allowPromptFrom: ["any"] }] }),
    )
    expect(any.grants.find(g => g.source === "session.allowPromptFrom")?.grant.principal).toBe("*")

    const prefix = deriveEffectiveGrants(
      input({ sessions: [{ id: "s1", allowPromptFrom: ["label:ops*"] }] }),
    )
    expect(prefix.grants.filter(g => g.source === "session.allowPromptFrom")).toEqual([])
    expect(prefix.unmapped).toHaveLength(1)
    expect(prefix.unmapped[0]).toMatchObject({
      source: "session.allowPromptFrom",
      entry: "label:ops*",
      sessionId: "s1",
    })

    const bad = deriveEffectiveGrants(
      input({ sessions: [{ id: "s1", allowPromptFrom: ["label:", "label:*", "sess_abc"] }] }),
    )
    expect(bad.grants.filter(g => g.source === "session.allowPromptFrom")).toEqual([])
    expect(bad.unmapped).toHaveLength(3)
    expect(bad.unmapped.every(u => u.source === "session.allowPromptFrom")).toBe(true)
  })

  it("reports operator delegates as unmapped, never as a grant", () => {
    const report = deriveEffectiveGrants(
      input({
        messaging: { ...DEFAULTS, allowSameWorkspace: false },
        operatorDelegates: ["label:pygmalion-brain-persistent"],
      }),
    )
    expect(report.grants).toEqual([])
    expect(report.unmapped).toHaveLength(1)
    expect(report.unmapped[0]).toMatchObject({
      source: "defaults.tasks.operatorDelegates",
      entry: "label:pygmalion-brain-persistent",
    })
  })
})

describe("resolveOperatorDelegates", () => {
  it("returns the configured list", async () => {
    const result = await resolveOperatorDelegates(async () => ({
      defaults: { tasks: { operatorDelegates: ["a", "b"] } },
    }))
    expect(result).toEqual(["a", "b"])
  })

  it("returns [] when the config has no list", async () => {
    expect(await resolveOperatorDelegates(async () => ({ defaults: {} }))).toEqual([])
  })

  it("returns [] when the loader throws", async () => {
    expect(
      await resolveOperatorDelegates(async () => {
        throw new Error("boom")
      }),
    ).toEqual([])
  })

  it("drops non-string entries", async () => {
    const result = await resolveOperatorDelegates(async () => ({
      defaults: { tasks: { operatorDelegates: ["a", 3, null] as unknown as string[] } },
    }))
    expect(result).toEqual(["a"])
  })
})
