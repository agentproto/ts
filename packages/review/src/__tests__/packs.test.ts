import { readFileSync } from "node:fs"
import { describe, it, expect } from "vitest"
import {
  parsePackManifest,
  parseReviewManifest,
  resolvePacks,
  PackManifestError,
  ReviewManifestError,
  type PackLoader,
  type PackSource,
} from "../index.js"

describe("parsePackManifest — @agentproto/review-pack-core", () => {
  it("the shipped pack (packages/review-pack-core) parses as a valid pack: preset-less agent checks, no bindings", () => {
    const source = readFileSync(new URL("../../../review-pack-core/REVIEW.md", import.meta.url), "utf8")
    const pack = parsePackManifest(source)
    expect(pack.id).toBe("core")
    expect(pack.checks.map((c) => c.id)).toEqual(["correctness", "security", "tests"])
    for (const check of pack.checks) {
      expect(check.kind).toBe("agent")
      expect((check as { preset?: string }).preset).toBeUndefined()
    }
  })
})

/** Build a pack's own REVIEW.md from frontmatter lines. */
const packMd = (...lines: string[]) => ["---", "kind: review-pack", "id: core", "version: 1.0.0", ...lines, "---", "", "Body."].join("\n")

/** Build a consumer REVIEW.md from frontmatter lines. */
const md = (...lines: string[]) => ["---", "kind: review", "id: demo", "target: git-range", ...lines, "---", "", "Body."].join("\n")

const CORE_PACK_SOURCE = packMd(
  "checks:",
  "  - {id: correctness, kind: agent, rubric: ./rubrics/correctness.md, blockOn: high}",
  "  - {id: security, kind: agent, rubric: ./rubrics/security.md, blockOn: medium}",
  "  - {id: lint, kind: command, run: eslint .}",
)

/** A fake loader backed by an in-memory map of ref -> pack source text +
 *  rubric bytes, so tests never touch the filesystem or network. */
function fakeLoader(opts: {
  packs: Record<string, { source: string; refKind?: PackSource["refKind"]; trusted?: boolean; root?: string }>
  rubrics?: Record<string, string>
}): PackLoader {
  return {
    async load(ref) {
      const entry = opts.packs[ref]
      if (!entry) throw new Error(`fakeLoader: no pack registered for '${ref}'`)
      const refKind = entry.refKind ?? "relative"
      return {
        manifest: parsePackManifest(entry.source),
        source: entry.source,
        refKind,
        // Mirrors the runtime loader's default: only a relative ref is ever
        // trusted, and even then only when the caller doesn't say otherwise
        // (tests below exercise trusted:false on a "relative" refKind to
        // prove resolvePacks gates on `trusted`, not `refKind`).
        trusted: entry.trusted ?? refKind === "relative",
        root: entry.root ?? "/packs/core",
        async readRubric(relPath) {
          const content = opts.rubrics?.[relPath]
          if (content === undefined) throw new Error(`fakeLoader: no rubric registered for '${relPath}'`)
          return Buffer.from(content, "utf8")
        },
      }
    },
  }
}

const CORE_RUBRICS = { "./rubrics/correctness.md": "Check correctness.", "./rubrics/security.md": "Check security." }

describe("parsePackManifest", () => {
  it("parses a pack's checks, presets optional", () => {
    const pack = parsePackManifest(CORE_PACK_SOURCE)
    expect(pack.id).toBe("core")
    expect(pack.version).toBe("1.0.0")
    expect(pack.checks.map((c) => c.id)).toEqual(["correctness", "security", "lint"])
    const correctness = pack.checks.find((c) => c.id === "correctness")
    expect(correctness).toMatchObject({ kind: "agent", rubric: "./rubrics/correctness.md" })
    expect((correctness as { preset?: string }).preset).toBeUndefined()
  })

  it("rejects bindings, prepare, or target — a pack is checks + rubrics only", () => {
    expect(() => parsePackManifest(packMd("bindings: {local: {checks: [correctness]}}", "checks:", "  - {id: correctness, kind: agent, rubric: ./r.md}"))).toThrow(
      PackManifestError,
    )
    expect(() => parsePackManifest(packMd("target: git-range", "checks:", "  - {id: x, kind: command, run: echo}"))).toThrow(PackManifestError)
  })

  it("rejects an effects: true check — a pack must never be mutation-capable", () => {
    expect(() => parsePackManifest(packMd("checks:", "  - {id: fmt, kind: command, run: prettier -w ., effects: true}"))).toThrow(
      /may not declare an 'effects: true' check/,
    )
  })

  it("rejects a non-semver version", () => {
    expect(() => parsePackManifest(["---", "kind: review-pack", "id: core", "version: latest", "checks:", "  - {id: x, kind: command, run: echo}", "---"].join("\n"))).toThrow(
      PackManifestError,
    )
  })
})

describe("resolvePacks", () => {
  const loader = fakeLoader({ packs: { "./core-pack": { source: CORE_PACK_SOURCE } }, rubrics: CORE_RUBRICS })

  it("is a no-op when the manifest declares no uses", async () => {
    const m = parseReviewManifest(md("checks:", "  - {id: types, kind: command, run: tsc}"))
    const resolved = await resolvePacks(m, loader)
    expect(resolved.manifest).toBe(m)
    expect(resolved.packs).toEqual([])
  })

  it("namespaces selected checks, resolves preset via uses.preset, and sets a pack digest", async () => {
    const m = parseReviewManifest(
      md(
        "uses:",
        "  - {pack: ./core-pack, as: core, preset: kimi, checks: [correctness, security]}",
        "checks:",
        "  - {id: types, kind: command, run: tsc}",
        "bindings:",
        "  local: {checks: [types, core/correctness, core/security]}",
      ),
    )
    const resolved = await resolvePacks(m, loader)
    const ids = resolved.manifest.checks.map((c) => c.id)
    expect(ids).toEqual(["types", "core/correctness", "core/security"])
    const correctness = resolved.manifest.checks.find((c) => c.id === "core/correctness") as { preset?: string; blockOn?: string; rubricBase?: string }
    expect(correctness.preset).toBe("kimi")
    expect(correctness.blockOn).toBe("high")
    expect(correctness.rubricBase).toBe("/packs/core")
    expect(resolved.manifest.bindings.local!.checks).toEqual(["types", "core/correctness", "core/security"])
    expect(resolved.packs).toHaveLength(1)
    expect(resolved.packs[0]).toMatchObject({ ref: "./core-pack", id: "core", version: "1.0.0" })
    expect(resolved.packs[0]!.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(resolved.packByNamespace.core).toEqual(resolved.packs[0])
  })

  it("applies a per-check override on top of the uses default preset", async () => {
    const m = parseReviewManifest(
      md(
        "uses:",
        "  - {pack: ./core-pack, as: core, preset: kimi, checks: [correctness], overrides: {correctness: {preset: opus, blockOn: low}}}",
        "checks: [{id: types, kind: command, run: tsc}]",
        "bindings:",
        "  local: {checks: [types, core/correctness]}",
      ),
    )
    const resolved = await resolvePacks(m, loader)
    const correctness = resolved.manifest.checks.find((c) => c.id === "core/correctness") as { preset?: string; blockOn?: string }
    expect(correctness.preset).toBe("opus")
    expect(correctness.blockOn).toBe("low")
  })

  it("the pack digest changes when a selected rubric's content changes", async () => {
    const m = parseReviewManifest(
      md(
        "uses:",
        "  - {pack: ./core-pack, as: core, preset: kimi, checks: [correctness]}",
        "checks: [{id: types, kind: command, run: tsc}]",
        "bindings:",
        "  local: {checks: [types, core/correctness]}",
      ),
    )
    const before = await resolvePacks(m, loader)
    const editedLoader = fakeLoader({
      packs: { "./core-pack": { source: CORE_PACK_SOURCE } },
      rubrics: { ...CORE_RUBRICS, "./rubrics/correctness.md": "Check correctness, EDITED." },
    })
    const after = await resolvePacks(m, editedLoader)
    expect(after.packs[0]!.sha256).not.toBe(before.packs[0]!.sha256)
  })

  it("errors naming the check when a command check has no allowCommands and the pack isn't relative", async () => {
    const npmLoader = fakeLoader({ packs: { "@scope/core": { source: CORE_PACK_SOURCE, refKind: "npm" } }, rubrics: CORE_RUBRICS })
    const m = parseReviewManifest(
      md(
        "uses:",
        "  - {pack: '@scope/core', as: core, preset: kimi, checks: [lint]}",
        "checks: [{id: types, kind: command, run: tsc}]",
        "bindings:",
        "  local: {checks: [types, core/lint]}",
      ),
    )
    await expect(resolvePacks(m, npmLoader)).rejects.toThrow(/check 'lint' is a command check/)
  })

  it("a relative-path pack's command check is exempt from allowCommands", async () => {
    const m = parseReviewManifest(
      md(
        "uses:",
        "  - {pack: ./core-pack, as: core, preset: kimi, checks: [lint]}",
        "checks: [{id: types, kind: command, run: tsc}]",
        "bindings:",
        "  local: {checks: [types, core/lint]}",
      ),
    )
    const resolved = await resolvePacks(m, loader)
    expect(resolved.manifest.checks.map((c) => c.id)).toContain("core/lint")
  })

  it("gates allowCommands on the loader's `trusted` flag, NOT on refKind — a 'relative' ref the loader marks untrusted still needs allowCommands", async () => {
    const untrustedLoader = fakeLoader({
      packs: { "./core-pack": { source: CORE_PACK_SOURCE, refKind: "relative", trusted: false } },
      rubrics: CORE_RUBRICS,
    })
    const m = parseReviewManifest(
      md(
        "uses:",
        "  - {pack: ./core-pack, as: core, preset: kimi, checks: [lint]}",
        "checks: [{id: types, kind: command, run: tsc}]",
        "bindings:",
        "  local: {checks: [types, core/lint]}",
      ),
    )
    await expect(resolvePacks(m, untrustedLoader)).rejects.toThrow(/check 'lint' is a command check/)
    // The same manifest resolves fine once allowCommands opts in explicitly.
    const mAllowed = parseReviewManifest(
      md(
        "uses:",
        "  - {pack: ./core-pack, as: core, preset: kimi, checks: [lint], allowCommands: true}",
        "checks: [{id: types, kind: command, run: tsc}]",
        "bindings:",
        "  local: {checks: [types, core/lint]}",
      ),
    )
    const resolved = await resolvePacks(mAllowed, untrustedLoader)
    expect(resolved.manifest.checks.map((c) => c.id)).toContain("core/lint")
  })

  it("wraps a readRubric failure (e.g. the runtime loader's path-confinement check) naming the check and pack", async () => {
    const escapingLoader = fakeLoader({
      packs: { "./core-pack": { source: CORE_PACK_SOURCE } },
      // No rubric registered for correctness — readRubric rejects, as the
      // real loader's confinement check would for a `../../` escape.
      rubrics: { "./rubrics/security.md": CORE_RUBRICS["./rubrics/security.md"] },
    })
    const m = parseReviewManifest(
      md(
        "uses:",
        "  - {pack: ./core-pack, as: core, preset: kimi, checks: [correctness]}",
        "checks: [{id: types, kind: command, run: tsc}]",
        "bindings:",
        "  local: {checks: [types, core/correctness]}",
      ),
    )
    await expect(resolvePacks(m, escapingLoader)).rejects.toThrow(
      /agent check 'correctness' rubric '\.\/rubrics\/correctness\.md'.*no rubric registered/,
    )
  })

  it("errors naming the check when an agent check resolves no preset anywhere", async () => {
    const m = parseReviewManifest(
      md(
        "uses:",
        "  - {pack: ./core-pack, as: core, checks: [correctness]}",
        "checks: [{id: types, kind: command, run: tsc}]",
        "bindings:",
        "  local: {checks: [types, core/correctness]}",
      ),
    )
    await expect(resolvePacks(m, loader)).rejects.toThrow(/agent check 'correctness' has no preset/)
  })

  it("errors when checks[] names a check the pack does not declare", async () => {
    const m = parseReviewManifest(
      md(
        "uses:",
        "  - {pack: ./core-pack, as: core, preset: kimi, checks: [nope]}",
        "checks: [{id: types, kind: command, run: tsc}]",
        "bindings:",
        "  local: {checks: [types]}",
      ),
    )
    await expect(resolvePacks(m, loader)).rejects.toThrow(/checks\[\] names 'nope'/)
  })

  it("finalizeBindings still enforces unknown-ref / blocking-required against the merged check set", async () => {
    const m = parseReviewManifest(
      md(
        "uses:",
        "  - {pack: ./core-pack, as: core, preset: kimi}",
        "checks: [{id: types, kind: command, run: tsc}]",
        "bindings:",
        "  local: {checks: [core/typo]}",
      ),
    )
    await expect(resolvePacks(m, loader)).rejects.toThrow(ReviewManifestError)
    await expect(resolvePacks(m, loader)).rejects.toThrow(/unknown check 'core\/typo'/)
  })
})

describe("parseReviewManifest — uses[]", () => {
  it("requires at least one explicit binding when uses is declared", () => {
    expect(() =>
      parseReviewManifest(md("uses:", "  - {pack: ./core-pack, as: core}", "checks: [{id: types, kind: command, run: tsc}]")),
    ).toThrow(/uses\[\] requires at least one explicit binding/)
  })

  it("rejects a floating git ref (branch/tag/short sha) — only a full 40-hex sha is reproducible", () => {
    expect(() =>
      parseReviewManifest(
        md(
          "uses:",
          "  - {pack: 'git+https://example.com/org/pack.git#main', as: core}",
          "checks: [{id: types, kind: command, run: tsc}]",
          "bindings:",
          "  local: {checks: [types]}",
        ),
      ),
    ).toThrow(/must be pinned to a full 40-hex commit sha/)
  })

  it.each([
    ["ssh transport", `git+ssh://git@example.com/org/pack.git#${"a".repeat(40)}`],
    ["file transport", `git+file:///tmp/pack#${"a".repeat(40)}`],
    ["ext:: transport (arbitrary local command execution)", `git+ext::sh -c 'touch /tmp/pwned'#${"a".repeat(40)}`],
    ["plain http (not https)", `git+http://example.com/org/pack.git#${"a".repeat(40)}`],
    ["a leading-dash ref masquerading as a git flag", `git+--upload-pack=touch /tmp/pwned#${"a".repeat(40)}`],
  ])("rejects a git pack ref that isn't git+https:// — %s", (_label, pack) => {
    expect(() =>
      parseReviewManifest(
        md("uses:", `  - {pack: ${JSON.stringify(pack)}, as: core}`, "checks: [{id: types, kind: command, run: tsc}]", "bindings:", "  local: {checks: [types]}"),
      ),
    ).toThrow(/must use git\+https:\/\//)
  })

  it("accepts a git ref pinned to a full 40-hex sha", () => {
    const sha = "a".repeat(40)
    const m = parseReviewManifest(
      md(
        "uses:",
        `  - {pack: 'git+https://example.com/org/pack.git#${sha}', as: core}`,
        "checks: [{id: types, kind: command, run: tsc}]",
        "bindings:",
        "  local: {checks: [types]}",
      ),
    )
    expect(m.uses[0]!.pack).toBe(`git+https://example.com/org/pack.git#${sha}`)
  })

  it("rejects a binding referencing an undeclared namespace", () => {
    expect(() =>
      parseReviewManifest(
        md(
          "uses:",
          "  - {pack: ./core-pack, as: core}",
          "checks: [{id: types, kind: command, run: tsc}]",
          "bindings:",
          "  local: {checks: [other/correctness]}",
        ),
      ),
    ).toThrow(/no uses\[\] entry declares namespace 'other'/)
  })
})
