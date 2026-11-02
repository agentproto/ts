import { describe, expect, it } from "vitest"

import {
  createClassifierRegistry,
  type Classifier,
  type ClassifyContext,
  type Envelope,
} from "../index.js"

const ctx: ClassifyContext = {
  targetId: "sess_1",
  facts: {
    reportedRecently: () => false,
    isDescendant: () => false,
    cronOutcome: () => undefined,
    supersededByNewTurn: () => false,
  },
}

function env(type: string, over: Partial<Envelope> = {}): Envelope {
  return {
    specversion: "1.0",
    id: "evt_1",
    source: "agentproto:test",
    type,
    subject: "acme:widget/1",
    subjects: ["acme:widget/1"],
    time: "2026-11-01T00:00:00.000Z",
    summary: "x",
    data: {},
    terminal: false,
    ...over,
  }
}

const fixed = (id: string, types: string[], level: 0 | 1 | 2 | 3 | undefined): Classifier => ({
  id,
  types,
  classify: () => level,
})

describe("createClassifierRegistry", () => {
  it("returns undefined from match when no classifier covers the type", () => {
    const reg = createClassifierRegistry()
    expect(reg.match(env("acme.widget.failed"))).toBeUndefined()
    reg.register(fixed("other", ["other.*"], 1))
    expect(reg.match(env("acme.widget.failed"))).toBeUndefined()
  })

  it("an unclassified envelope is never dropped: default rule, level hint or 2", () => {
    const reg = createClassifierRegistry()
    expect(reg.classify(env("acme.widget.failed"), ctx)).toEqual({ level: 2, rule: "default" })
    expect(reg.classify(env("acme.widget.failed", { levelHint: 1 }), ctx)).toEqual({
      level: 1,
      rule: "default",
    })
  })

  it("first registered match wins, in registration order", () => {
    const reg = createClassifierRegistry()
    reg.register(fixed("specific", ["acme.widget.failed"], 3))
    reg.register(fixed("broad", ["acme.*"], 1))
    expect(reg.classify(env("acme.widget.failed"), ctx)).toEqual({ level: 3, rule: "specific" })
    expect(reg.classify(env("acme.widget.ok"), ctx)).toEqual({ level: 1, rule: "broad" })
    expect(reg.list().map((c) => c.id)).toEqual(["specific", "broad"])
  })

  it("a classifier that declines falls through to the next match", () => {
    const reg = createClassifierRegistry()
    reg.register(fixed("decliner", ["acme.*"], undefined))
    reg.register(fixed("next", ["acme.*"], 0))
    expect(reg.classify(env("acme.widget.failed"), ctx)).toEqual({ level: 0, rule: "next" })
  })

  it("registering a duplicate id replaces in place and keeps its position", () => {
    const reg = createClassifierRegistry()
    reg.register(fixed("a", ["acme.*"], 1))
    reg.register(fixed("b", ["acme.*"], 2))
    reg.register(fixed("a", ["acme.*"], 3))
    expect(reg.list().map((c) => c.id)).toEqual(["a", "b"])
    expect(reg.classify(env("acme.widget.failed"), ctx)).toEqual({ level: 3, rule: "a" })
  })

  it("the unregister function removes the classifier, but not a replacement", () => {
    const reg = createClassifierRegistry()
    const off = reg.register(fixed("a", ["acme.*"], 1))
    reg.register(fixed("a", ["acme.*"], 3))
    off()
    expect(reg.list()).toHaveLength(1)
    const off2 = reg.register(fixed("b", ["acme.*"], 1))
    off2()
    expect(reg.list().map((c) => c.id)).toEqual(["a"])
  })

  it("type globs are exact or trailing star; a bare star matches everything", () => {
    const reg = createClassifierRegistry()
    reg.register(fixed("exact", ["acme.widget.failed"], 3))
    expect(reg.match(env("acme.widget.failed"))?.id).toBe("exact")
    expect(reg.match(env("acme.widget.failed2"))).toBeUndefined()
    reg.register(fixed("all", ["*"], 1))
    expect(reg.match(env("anything.at.all"))?.id).toBe("all")
  })

  it("registries are independent, not module-global", () => {
    const a = createClassifierRegistry()
    const b = createClassifierRegistry()
    a.register(fixed("a", ["*"], 1))
    expect(b.list()).toEqual([])
  })
})
