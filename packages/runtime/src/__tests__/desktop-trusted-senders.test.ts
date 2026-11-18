import { describe, expect, it } from "vitest"
import { validateConfig, validateConfigKeyValue } from "../config-schema.js"
import {
  isTrustedSender, normalizeTrustedSenders, resolveTrustedSenders, type TrustedSenderSession,
} from "../desktop-trusted-senders.js"

const rows: Record<string, TrustedSenderSession> = {
  root: { kind: "agent", operatorLabel: "brain" },
  child: { kind: "agent", parentSessionId: "root" },
  grandchild: { kind: "agent", parentSessionId: "child" },
  orphan: { kind: "agent", parentSessionId: "gone" },
  loopA: { kind: "agent", parentSessionId: "loopB" },
  loopB: { kind: "agent", parentSessionId: "loopA" },
  "cc:ext": { kind: "external" },
  "claude-desktop": { kind: "external" },
}
const lookup = (id: string) => rows[id]
const from = (sessionId: string, extra: Record<string, unknown> = {}) =>
  ({ sessionId, relation: "granted" as const, ...extra })

describe("isTrustedSender", () => {
  it("is off by default and for unknown values", () => {
    expect(isTrustedSender("off", from("root"), lookup)).toBe(false)
    expect(normalizeTrustedSenders(undefined)).toBe("off")
    expect(normalizeTrustedSenders("everyone")).toBe("off")
    expect(normalizeTrustedSenders(["a", 3, ""])).toEqual(["a"])
  })

  it("operator: a root session and a human, not its descendants", () => {
    expect(isTrustedSender("operator", from("root"), lookup)).toBe(true)
    expect(isTrustedSender("operator", { relation: "human" }, lookup)).toBe(true)
    expect(isTrustedSender("operator", from("child"), lookup)).toBe(false)
    expect(isTrustedSender("operator", from("nobody"), lookup)).toBe(false)
  })

  it("tree: the root and everything spawned beneath it, if the lineage resolves", () => {
    for (const id of ["root", "child", "grandchild"]) expect(isTrustedSender("tree", from(id), lookup)).toBe(true)
    expect(isTrustedSender("tree", from("orphan"), lookup)).toBe(false)
    expect(isTrustedSender("tree", from("loopA"), lookup)).toBe(false)
  })

  it("never trusts system, anonymous, external rows or an unverified sender under a mode", () => {
    for (const policy of ["operator", "tree"] as const) {
      expect(isTrustedSender(policy, { relation: "system" }, lookup)).toBe(false)
      expect(isTrustedSender(policy, { relation: "granted", anonymous: true }, lookup)).toBe(false)
      expect(isTrustedSender(policy, from("cc:ext"), lookup)).toBe(false)
      expect(isTrustedSender(policy, from("claude-desktop", { unverified: true }), lookup)).toBe(false)
    }
    expect(isTrustedSender(["human", "root"], { relation: "system" }, lookup)).toBe(false)
    expect(isTrustedSender(["root"], from("root", { anonymous: true }), lookup)).toBe(false)
  })

  it("list: exact session ids, operator labels, human; unverified claude-desktop only when listed", () => {
    expect(isTrustedSender(["child"], from("child"), lookup)).toBe(true)
    expect(isTrustedSender(["child"], from("grandchild"), lookup)).toBe(false)
    expect(isTrustedSender(["label:brain"], from("root"), lookup)).toBe(true)
    expect(isTrustedSender(["label:other"], from("root"), lookup)).toBe(false)
    expect(isTrustedSender(["human"], { relation: "human" }, lookup)).toBe(true)
    expect(isTrustedSender(["root"], { relation: "human" }, lookup)).toBe(false)
    const desktop = from("claude-desktop", { unverified: true })
    expect(isTrustedSender(["root"], desktop, lookup)).toBe(false)
    expect(isTrustedSender(["claude-desktop"], desktop, lookup)).toBe(true)
    // a display label or a declared sender never grants trust
    expect(isTrustedSender(["label:brain"], from("claude-desktop", { unverified: true, label: "brain" }), lookup)).toBe(false)
    expect(isTrustedSender(["sess_x"], from("claude-desktop", { unverified: true, declaredSender: "sess_x" }), lookup)).toBe(false)
  })

  it("a per-thread entry wins over the daemon-wide one", () => {
    expect(resolveTrustedSenders("tree", { t: "off" }, "t")).toBe("off")
    expect(resolveTrustedSenders("tree", { t: "off" }, "u")).toBe("tree")
    expect(resolveTrustedSenders(undefined, undefined, "t")).toBe("off")
  })
})

describe("config", () => {
  const thread = "00000000-0000-4000-8000-000000000002"
  it("validates the policy words, lists and per-thread map, and keeps them read-only over MCP", () => {
    for (const v of ["off", "operator", "tree", ["sess_a", "label:x", "claude-desktop"]]) {
      expect(validateConfig({ daemon: { desktopTrustedSenders: v } }).ok).toBe(true)
    }
    expect(validateConfig({ daemon: { desktopTrustedSenders: "all" } }).ok).toBe(false)
    expect(validateConfig({ daemon: { desktopTrustedSendersByThread: { [thread]: "tree" } } }).ok).toBe(true)
    expect(validateConfig({ daemon: { desktopTrustedSendersByThread: { nope: "tree" } } }).ok).toBe(false)
    expect(validateConfigKeyValue("daemon.desktopTrustedSenders", "tree").ok).toBe(false)
    expect(validateConfigKeyValue("daemon.desktopTrustedSendersByThread", {}).ok).toBe(false)
  })
})
