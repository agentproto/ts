import { readFileSync } from "node:fs"
import { describe, it, expect } from "vitest"
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  parseReviewManifest,
  resolveBinding,
  ReviewManifestError,
} from "../index.js"

const EXAMPLE = readFileSync(new URL("../../examples/REVIEW.md", import.meta.url), "utf8")

/** Build a REVIEW.md from frontmatter lines. */
const md = (...lines: string[]) => ["---", "kind: review", "id: demo", "target: git-range", ...lines, "---", "", "Body."].join("\n")

describe("parseReviewManifest — the example manifest", () => {
  const m = parseReviewManifest(EXAMPLE)

  it("parses checks with every default applied", () => {
    expect(m.id).toBe("agentproto-ts")
    expect(m.target).toEqual({ kind: "git-range", base: "origin/main" })
    expect(m.checks.map((c) => c.id)).toEqual(["types", "changeset", "build", "correctness"])
    expect(m.checks[0]).toEqual({
      id: "types",
      kind: "command",
      run: "turbo run check-types --filter={changed}",
      blocking: true,
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
      effects: false,
    })
    expect(m.checks[1]).toMatchObject({ id: "changeset", effects: true })
    expect(m.checks[3]).toEqual({
      id: "correctness",
      kind: "agent",
      preset: "kimi",
      rubric: "./rubrics/correctness.md",
      blockOn: "high",
      blocking: true,
      timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
      effects: false,
    })
  })

  it("parses both bindings with the default quorum", () => {
    expect(m.bindings.local).toEqual({
      name: "local",
      on: "pre-push",
      prepare: ["changeset"],
      checks: ["types", "correctness"],
      quorum: "all-blocking-pass",
    })
    expect(m.bindings.ci).toEqual({
      name: "ci",
      on: "pr",
      prepare: [],
      checks: ["build", "correctness"],
      quorum: "all-blocking-pass",
    })
    expect(m.verdict).toEqual({ exportDir: ".reviews" })
    expect(m.body).toContain("# agentproto/ts review")
  })

  it("resolves bindings by name and refuses an ambiguous or unknown one", () => {
    expect(resolveBinding(m, "ci").name).toBe("ci")
    expect(() => resolveBinding(m)).toThrow(/declares several bindings \(local, ci\) — name one/)
    expect(() => resolveBinding(m, "nightly")).toThrow(/no binding 'nightly' — available: local, ci/)
  })
})

describe("parseReviewManifest — effects enforcement", () => {
  it("rejects an effects check listed as an attesting lane", () => {
    const src = md(
      "checks:",
      "  - {id: types, kind: command, run: tsc}",
      "  - {id: fmt, kind: command, run: prettier -w ., effects: true}",
      "bindings:",
      "  local: {checks: [types, fmt]}",
    )
    expect(() => parseReviewManifest(src)).toThrow(ReviewManifestError)
    expect(() => parseReviewManifest(src)).toThrow(
      /binding 'local' checks lists 'fmt', an 'effects: true' check — a mutation-capable check can only run in a binding's 'prepare' phase/,
    )
  })

  it("rejects a read-only check listed under prepare", () => {
    const src = md(
      "checks:",
      "  - {id: types, kind: command, run: tsc}",
      "bindings:",
      "  local: {prepare: [types], checks: [types]}",
    )
    expect(() => parseReviewManifest(src)).toThrow(/prepare lists 'types', which is not an 'effects: true' check/)
  })

  it("rejects effects on an agent check", () => {
    const src = md("checks:", "  - {id: fixer, kind: agent, preset: p, rubric: r.md, effects: true}")
    expect(() => parseReviewManifest(src)).toThrow(/'effects: true' is only supported on command checks/)
  })

  it("leaves effects checks out of the implied default binding", () => {
    const m = parseReviewManifest(
      md(
        "checks:",
        "  - {id: types, kind: command, run: tsc}",
        "  - {id: fmt, kind: command, run: prettier -w ., effects: true}",
        "  - {id: lint, kind: command, run: eslint ., blocking: false}",
      ),
    )
    expect(Object.keys(m.bindings)).toEqual(["default"])
    expect(m.bindings.default).toEqual({
      name: "default",
      prepare: [],
      checks: ["types", "lint"],
      quorum: "all-blocking-pass",
    })
    expect(resolveBinding(m).name).toBe("default")
  })
})

describe("parseReviewManifest — references and shape", () => {
  it("rejects an unknown check ref in checks", () => {
    const src = md("checks:", "  - {id: types, kind: command, run: tsc}", "bindings:", "  ci: {checks: [types, tests]}")
    expect(() => parseReviewManifest(src)).toThrow(/binding 'ci' checks references unknown check 'tests'/)
  })

  it("rejects an unknown check ref in prepare", () => {
    const src = md(
      "checks:",
      "  - {id: types, kind: command, run: tsc}",
      "bindings:",
      "  ci: {prepare: [changeset], checks: [types]}",
    )
    expect(() => parseReviewManifest(src)).toThrow(/binding 'ci' prepare references unknown check 'changeset'/)
  })

  it("rejects duplicate check ids and duplicate refs", () => {
    expect(() =>
      parseReviewManifest(md("checks:", "  - {id: a, kind: command, run: x}", "  - {id: a, kind: command, run: y}")),
    ).toThrow(/checks\[\] lists 'a' more than once/)
    expect(() =>
      parseReviewManifest(md("checks:", "  - {id: a, kind: command, run: x}", "bindings:", "  ci: {checks: [a, a]}")),
    ).toThrow(/binding 'ci' checks lists 'a' more than once/)
  })

  it("rejects a binding whose lanes are all advisory", () => {
    const src = md("checks:", "  - {id: lint, kind: command, run: eslint ., blocking: false}")
    expect(() => parseReviewManifest(src)).toThrow(/binding 'default' selects no blocking check/)
  })

  it("rejects unknown fields, a wrong kind, and an unsupported target", () => {
    expect(() => parseReviewManifest(md("checks:", "  - {id: a, kind: command, run: x, shell: bash}"))).toThrow(
      /invalid frontmatter/,
    )
    expect(() =>
      parseReviewManifest(md("checks:", "  - {id: a, kind: command, run: x}").replace("kind: review", "kind: workflow")),
    ).toThrow(/kind/)
    expect(() =>
      parseReviewManifest(md("checks:", "  - {id: a, kind: command, run: x}").replace("target: git-range", "target: files")),
    ).toThrow(/target/)
  })

  it("rejects a missing frontmatter", () => {
    expect(() => parseReviewManifest("# just a body\n")).toThrow(/missing or empty frontmatter/)
  })

  it("accepts the bare `target: git-range` form with the default base", () => {
    const m = parseReviewManifest(md("checks:", "  - {id: a, kind: command, run: x}"))
    expect(m.target).toEqual({ kind: "git-range", base: "origin/main" })
  })
})
