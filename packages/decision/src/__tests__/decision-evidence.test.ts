/**
 * Bounded evidence collection: metadata by default, paths/code only on policy
 * opt-in, secrets scrubbed, every failure degrading to `complete: false`.
 * A fake git runner stands in for the repository.
 */

import { describe, expect, it } from "vitest"

import { collectEvidence, sanitizeEvidence, scrubSecrets, type GitRunner } from "../decision-evidence.js"
import { parseDecisionPolicy, type DecisionPolicy } from "../decision-policy.js"

const FIXTURE = `---
schema: 1
name: t
version: 1
choices: [light, standard, deep]
default: deep
criteria:
  light: docs only
  standard: ordinary code
  deep: risky
{{EVIDENCE}}
---
body
`

function policy(evidenceYaml = ""): DecisionPolicy {
  const parsed = parseDecisionPolicy(FIXTURE.replace("{{EVIDENCE}}", evidenceYaml))
  if (!parsed.ok) throw new Error(`fixture invalid: ${JSON.stringify(parsed)}`)
  return parsed.policy
}

const BASE = "a".repeat(40)
const HEAD = "b".repeat(40)

function numstat(rows: Array<[number | "-", number | "-", string]>): string {
  return rows.map(([a, d, p]) => `${a}\t${d}\t${p}\0`).join("")
}

function fakeGit(diff: string | Error, calls: string[][] = []): GitRunner {
  return async (_cwd, args) => {
    calls.push([...args])
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) return "/repo\n"
    if (args[0] === "rev-parse") return `${args.some(a => a.startsWith("origin/dev")) ? BASE : HEAD}\n`
    if (args[0] === "merge-base") return `${BASE}\n`
    if (args[0] === "diff") {
      if (diff instanceof Error) throw diff
      return diff
    }
    throw new Error(`unexpected git ${args.join(" ")}`)
  }
}

describe("collectEvidence — metadata only by default", () => {
  it("exports counts, categories and signals — never paths", async () => {
    const out = await collectEvidence({
      cwd: "/repo",
      policy: policy(),
      git: fakeGit(
        numstat([
          [10, 2, "src/auth/login.ts"],
          [3, 0, "docs/readme.md"],
          [1, 1, "src/app.test.ts"],
        ]),
      ),
    })
    expect(out.complete).toBe(true)
    expect(out.range).toEqual({ root: "/repo", baseSha: BASE, headSha: HEAD })
    expect(out.evidence).toMatchObject({
      changeCounts: { files: 3, additions: 14, deletions: 3, docs: 1, test: 1, code: 1 },
      riskCategories: ["auth"],
      signals: ["hardRisk"],
      complete: true,
    })
    const wire = JSON.stringify(out.evidence)
    expect(wire).not.toContain("src/auth/login.ts")
    expect(wire).not.toContain("docs/readme.md")
    expect(out.evidence.paths).toBeUndefined()
    expect(out.withheld).toContain("paths")
  })

  it("exports paths only when the policy opts in", async () => {
    const out = await collectEvidence({
      cwd: "/repo",
      policy: policy("evidence:\n  allowPaths: true"),
      git: fakeGit(numstat([[1, 0, "src/a.ts"]])),
    })
    expect(out.evidence.paths).toEqual(["src/a.ts"])
    expect(out.withheld).not.toContain("paths")
  })

  it("allowCode releases nothing: the collector never reads hunks or contents", async () => {
    const calls: string[][] = []
    const out = await collectEvidence({
      cwd: "/repo",
      policy: policy("evidence:\n  allowCode: true"),
      git: fakeGit(numstat([[1, 0, "src/a.ts"]]), calls),
    })
    expect(JSON.stringify(out.evidence)).not.toContain("src/a.ts")
    for (const c of calls) expect(c).not.toContain("-p")
    const diff = calls.find(c => c[0] === "diff")!
    expect(diff).toContain("--numstat")
  })

  it("freezes the range to shas (explicit base) and diffs exactly that range", async () => {
    const calls: string[][] = []
    await collectEvidence({ cwd: "/repo", base: "origin/dev", head: "feature", policy: policy(), git: fakeGit(numstat([]), calls) })
    expect(calls.some(c => c[0] === "rev-parse" && c.includes("feature^{commit}"))).toBe(true)
    expect(calls.some(c => c[0] === "rev-parse" && c.includes("origin/dev^{commit}"))).toBe(true)
    expect(calls.find(c => c[0] === "diff")).toEqual(expect.arrayContaining([BASE, HEAD]))
  })

  it("flags large and binary changes", async () => {
    const out = await collectEvidence({
      cwd: "/repo",
      policy: policy(),
      git: fakeGit(numstat([[2000, 0, "src/big.ts"], ["-", "-", "assets/logo.png"]])),
    })
    expect(out.evidence.signals).toEqual(expect.arrayContaining(["large", "binary"]))
  })
})

describe("collectEvidence — failure is incompleteness, never a clean range", () => {
  it("an unfreezable range yields complete:false with no range and no diff attempt", async () => {
    const calls: string[][] = []
    const git: GitRunner = async (_c, args) => {
      calls.push([...args])
      throw new Error("not a git repository")
    }
    const out = await collectEvidence({ cwd: "/nope", policy: policy(), git })
    expect(out.complete).toBe(false)
    expect(out.range).toBeUndefined()
    expect(out.evidence).toMatchObject({ complete: false, completeness: 0 })
    expect(out.notes.join(" ")).toMatch(/range could not be frozen/)
    expect(calls.some(c => c[0] === "diff")).toBe(false)
  })

  it("a failing diff stat is incomplete (range kept, completeness 0)", async () => {
    const out = await collectEvidence({ cwd: "/repo", policy: policy(), git: fakeGit(new Error("diff exploded")) })
    expect(out.complete).toBe(false)
    expect(out.range).toBeDefined()
    expect(out.evidence).toMatchObject({ complete: false, completeness: 0 })
  })

  it("truncates at maxFiles and says so (completeness 0.5)", async () => {
    const rows: Array<[number, number, string]> = Array.from({ length: 10 }, (_, i) => [1, 0, `src/f${i}.ts`])
    const out = await collectEvidence({ cwd: "/repo", policy: policy(), maxFiles: 4, git: fakeGit(numstat(rows)) })
    expect(out.complete).toBe(false)
    expect(out.evidence).toMatchObject({ completeness: 0.5, changeCounts: { files: 4 } })
    expect(out.notes.join(" ")).toMatch(/truncated at 4/)
  })
})

describe("collectEvidence — supplied evidence", () => {
  it("is sanitized, secrets scrubbed, denied classes dropped, refs merged with the frozen range", async () => {
    const out = await collectEvidence({
      cwd: "/repo",
      policy: policy(),
      git: fakeGit(""),
      supplied: {
        changeTypes: "code",
        note: "token sk-abcdefghijklmnopqrstuvwxyz0123 leaked",
        paths: ["src/secret.ts"],
        diff: "+ code",
        evidenceRefs: ["router:v1"],
      },
    })
    const wire = JSON.stringify(out.evidence)
    expect(wire).not.toContain("sk-abcdefghijklmnop")
    expect(wire).not.toContain("src/secret.ts")
    expect(out.evidence.diff).toBeUndefined()
    expect(out.evidence.evidenceRefs).toEqual(expect.arrayContaining(["router:v1", expect.stringMatching(/^range:/)]))
    expect(out.withheld).toEqual(expect.arrayContaining(["secrets", "paths"]))
    expect(out.complete).toBe(true)
  })

  it("supplied completeness < 1 or complete:false makes the evidence incomplete", async () => {
    const a = await collectEvidence({ cwd: "/repo", policy: policy(), git: fakeGit(""), supplied: { completeness: 0.4 } })
    const b = await collectEvidence({ cwd: "/repo", policy: policy(), git: fakeGit(""), supplied: { complete: false } })
    expect(a.complete).toBe(false)
    expect(b.complete).toBe(false)
  })
})

describe("scrubSecrets / sanitizeEvidence", () => {
  it("redacts common credential shapes", () => {
    const text = [
      "sk-abcdefghijklmnopqrstuvwx",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "AKIAABCDEFGHIJKLMNOP",
      "Bearer abcdefghijklmnopqrstuv",
      "a".repeat(64),
    ].join(" ")
    const out = scrubSecrets(text)
    expect(out).not.toMatch(/sk-abcdef|ghp_abcdef|AKIAABCD|Bearer abcdef|a{40}/)
    expect(out).toContain("[redacted]")
  })

  it("caps long strings and nested values", () => {
    const { evidence } = sanitizeEvidence(policy(), { note: "x ".repeat(400), nested: { k: "y".repeat(500) } })
    expect(String(evidence.note).length).toBeLessThan(260)
    expect(String((evidence.nested as { k: string }).k).length).toBeLessThan(260)
  })
})
