import { describe, expect, it } from "vitest"

import {
  createClassifierRegistry,
  type Classifier,
  type ClassifyContext,
  type Envelope,
} from "../index.js"

const ctx: ClassifyContext = { targetId: "sess_1" }

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
  it("an uncovered type falls back to the default rule", () => {
    const reg = createClassifierRegistry([fixed("other", ["other.*"], 1)])
    expect(reg.classify(env("acme.widget.failed"), ctx)).toEqual({ level: 2, rule: "default" })
  })

  it("an unclassified envelope is never dropped: default rule, level hint or 2", () => {
    const reg = createClassifierRegistry([])
    expect(reg.classify(env("acme.widget.failed"), ctx)).toEqual({ level: 2, rule: "default" })
    expect(reg.classify(env("acme.widget.failed", { levelHint: 1 }), ctx)).toEqual({
      level: 1,
      rule: "default",
    })
  })

  it("first match wins, in array order", () => {
    const reg = createClassifierRegistry([
      fixed("specific", ["acme.widget.failed"], 3),
      fixed("broad", ["acme.*"], 1),
    ])
    expect(reg.classify(env("acme.widget.failed"), ctx)).toEqual({ level: 3, rule: "specific" })
    expect(reg.classify(env("acme.widget.ok"), ctx)).toEqual({ level: 1, rule: "broad" })

    const reversed = createClassifierRegistry([
      fixed("broad", ["acme.*"], 1),
      fixed("specific", ["acme.widget.failed"], 3),
    ])
    expect(reversed.classify(env("acme.widget.failed"), ctx)).toEqual({ level: 1, rule: "broad" })
  })

  it("a classifier that declines falls through to the next match", () => {
    const reg = createClassifierRegistry([
      fixed("decliner", ["acme.*"], undefined),
      fixed("next", ["acme.*"], 0),
    ])
    expect(reg.classify(env("acme.widget.failed"), ctx)).toEqual({ level: 0, rule: "next" })
  })

  it("type globs are exact or trailing star; a bare star matches everything", () => {
    const exactOnly = createClassifierRegistry([fixed("exact", ["acme.widget.failed"], 3)])
    expect(exactOnly.classify(env("acme.widget.failed"), ctx)).toEqual({ level: 3, rule: "exact" })
    expect(exactOnly.classify(env("acme.widget.failed2"), ctx)).toEqual({
      level: 2,
      rule: "default",
    })
    const all = createClassifierRegistry([fixed("all", ["*"], 1)])
    expect(all.classify(env("anything.at.all"), ctx)).toEqual({ level: 1, rule: "all" })
  })
})
