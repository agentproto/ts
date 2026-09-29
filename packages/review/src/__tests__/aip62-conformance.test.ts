/**
 * AIP-62 conformance: the EXAMPLES.md reference blocks and digest test
 * vectors run through the shipped code, and the two authoring paths
 * (`parseReviewManifest` for REVIEW.md, `defineReview` for TS) are held to
 * one schema and one set of diagnostics.
 */
import matter from "gray-matter"
import { describe, expect, it } from "vitest"
import {
  attestationFrontmatterSchema,
  buildAttestation,
  canonicalJson,
  checkReviewFrontmatter,
  computePackDigestSha256,
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_BASE_REF,
  DEFAULT_COMMAND_TIMEOUT_MS,
  defineReview,
  GitPackRefError,
  manifestSha,
  parseGitPackRef,
  parsePackManifest,
  parseReviewManifest,
  rangeSha,
  ReviewManifestError,
  reviewFrontmatterSchema,
  reviewPackFrontmatterSchema,
  sha256Hex,
  type ReviewDefinition,
} from "../index.js"
import {
  EXAMPLE_ATTESTATION,
  EXAMPLE_CONSUMER,
  EXAMPLE_PACK,
  EXAMPLE_PUSH_GATE,
  EXAMPLE_TWO_BINDINGS,
} from "./fixtures/aip62-examples.js"

const frontmatter = (md: string): ReviewDefinition => matter(md).data as ReviewDefinition

describe("EXAMPLES.md §6 test vectors", () => {
  it("pack digest (agentproto-pack-digest/v1)", () => {
    expect(sha256Hex("pack-md\n")).toBe("0cccf656cc21d2203de4ff8f31c8f0791812ee17d36176fc47562ff3681b864b")
    expect(sha256Hex("rubric\n")).toBe("3c1d98d1ff2816d52bf2e03c3e46c3220107999b2a26f0811b5cde42d9bfe042")
    expect(
      computePackDigestSha256("pack-md\n", [
        { path: "./rubrics/correctness.md", bytes: new TextEncoder().encode("rubric\n") },
      ]),
    ).toBe("fe060a88f5bb7f3fdc86d883b1681665cd633d5a8cc5bcdb6d0b32112ed173a7")
  })

  it("range digest", () => {
    expect(rangeSha({ baseSha: "1".repeat(40), headSha: "2".repeat(40) })).toBe(
      "709ea9c102cd11ed178afc5f0d3bef72b86e55ec7de29a6fb125fb100ef166a8",
    )
  })

  it("canonical JSON", () => {
    expect(canonicalJson({ b: 1, a: [{ z: true, y: undefined, x: "é" }] })).toBe('{"a":[{"x":"é","z":true}],"b":1}')
  })
})

describe("EXAMPLES.md reference blocks", () => {
  const manifests = {
    "§1 push gate": EXAMPLE_PUSH_GATE,
    "§2 two bindings + prepare + exportDir": EXAMPLE_TWO_BINDINGS,
    "§4 consumer (uses[])": EXAMPLE_CONSUMER,
  }

  for (const [label, md] of Object.entries(manifests)) {
    it(`${label}: parses identically via parseReviewManifest and defineReview`, () => {
      const parsed = parseReviewManifest(md)
      const { body, ...expected } = parsed
      expect(body.length).toBeGreaterThan(0)
      expect(defineReview(frontmatter(md))).toEqual(expected)
    })
  }

  it("§3 pack validates against the pack schema and parses", () => {
    expect(reviewPackFrontmatterSchema.safeParse(matter(EXAMPLE_PACK).data).success).toBe(true)
    const pack = parsePackManifest(EXAMPLE_PACK)
    expect(pack.checks.map((c) => c.id)).toEqual(["correctness", "security"])
  })

  it("§5 attestation validates against the attestation schema", () => {
    const result = attestationFrontmatterSchema.safeParse(JSON.parse(EXAMPLE_ATTESTATION))
    expect(result.success, result.success ? "" : JSON.stringify(result.error.issues)).toBe(true)
  })

  it("§5 attestation's rangeSha and core pack digest are the §6 vectors", () => {
    const att = JSON.parse(EXAMPLE_ATTESTATION)
    expect(att.rangeSha).toBe(rangeSha(att.target))
    expect(att.packs[0].sha256).toBe("fe060a88f5bb7f3fdc86d883b1681665cd633d5a8cc5bcdb6d0b32112ed173a7")
  })

  it("§5 attestation: the schema rejects what the spec forbids", () => {
    const att = JSON.parse(EXAMPLE_ATTESTATION)
    const bad = (over: Record<string, unknown>) => attestationFrontmatterSchema.safeParse({ ...att, ...over }).success
    expect(bad({})).toBe(true)
    expect(bad({ verdict: "maybe" })).toBe(false)
    expect(bad({ dirty: false })).toBe(false)
    expect(bad({ runId: "run-1" })).toBe(false)
    expect(bad({ packs: [{ ...att.packs[0], alg: "agentproto-pack-digest/v0" }] })).toBe(false)
  })

  it("a buildAttestation output validates against the attestation schema", () => {
    const att = buildAttestation({
      runId: "review-6f0b9a52-3f43-4c1c-a4d5-0f3f6c1f5a10",
      reviewId: "demo",
      manifestSha: manifestSha(EXAMPLE_PUSH_GATE),
      binding: "local",
      target: { repoRemote: "github.com/acme/repo", baseSha: "a".repeat(40), headSha: "c".repeat(40) },
      lanes: [{ id: "types", kind: "command", status: "pass", blocking: true, findings: [], durationMs: 10 }],
      attestor: { daemon: "host:18790", presets: ["kimi"] },
    })
    const result = attestationFrontmatterSchema.safeParse(JSON.parse(JSON.stringify(att)))
    expect(result.success, result.success ? "" : JSON.stringify(result.error.issues)).toBe(true)
  })
})

describe("defaults", () => {
  it("the exported default constants equal the schema's own defaults", () => {
    const fm = checkReviewFrontmatter({
      kind: "review",
      id: "x",
      target: "git-range",
      checks: [
        { id: "a", kind: "command", run: "true" },
        { id: "b", kind: "agent", preset: "p", rubric: "./r.md" },
      ],
    })
    const [a, b] = fm.checks
    expect(a!.timeoutMs).toBe(DEFAULT_COMMAND_TIMEOUT_MS)
    expect(b!.timeoutMs).toBe(DEFAULT_AGENT_TIMEOUT_MS)
    expect(parseReviewManifest("---\nkind: review\nid: x\ntarget: git-range\nchecks:\n  - {id: a, kind: command, run: 'true'}\n---\n").target.base).toBe(
      DEFAULT_BASE_REF,
    )
    expect(checkReviewFrontmatter({ ...fm, target: { kind: "git-range" } }).target).toEqual({
      kind: "git-range",
      base: DEFAULT_BASE_REF,
    })
  })
})

describe("defineReview", () => {
  const base = (over: Record<string, unknown> = {}): ReviewDefinition =>
    ({
      kind: "review",
      id: "demo",
      target: "git-range",
      checks: [
        { id: "types", kind: "command", run: "pnpm check-types" },
        { id: "fmt", kind: "command", run: "pnpm fmt", effects: true },
        { id: "lint", kind: "command", run: "pnpm lint", blocking: false },
        { id: "correctness", kind: "agent", preset: "kimi", rubric: "./rubrics/correctness.md" },
      ],
      ...over,
    }) as ReviewDefinition

  it("returns a deeply frozen handle with every default applied", () => {
    const h = defineReview(base())
    expect(Object.isFrozen(h)).toBe(true)
    expect(Object.isFrozen(h.checks)).toBe(true)
    expect(Object.isFrozen(h.checks[0])).toBe(true)
    expect(Object.isFrozen(h.bindings.default)).toBe(true)
    expect(h.target).toEqual({ kind: "git-range", base: "origin/main" })
    expect(h.bindings.default!.checks).toEqual(["types", "lint", "correctness"])
    expect("body" in h).toBe(false)
  })

  const violations: Record<string, ReviewDefinition> = {
    "duplicate check id": base({ checks: [{ id: "a", kind: "command", run: "x" }, { id: "a", kind: "command", run: "y" }] }),
    "binding references an unknown check": base({ bindings: { ci: { checks: ["nope"] } } }),
    "an effects:true check in a binding's checks": base({ bindings: { ci: { checks: ["types", "fmt"] } } }),
    "a prepare entry that is not effects:true": base({ bindings: { ci: { prepare: ["types"], checks: ["correctness"] } } }),
    "a prepare entry that is unknown": base({ bindings: { ci: { prepare: ["nope"], checks: ["correctness"] } } }),
    "a binding with no blocking check": base({ bindings: { ci: { checks: ["lint"] } } }),
    "a duplicate ref inside a binding": base({ bindings: { ci: { checks: ["types", "types"] } } }),
    "no non-effects check to imply a default binding": base({
      checks: [{ id: "fmt", kind: "command", run: "pnpm fmt", effects: true }],
    }),
    "uses[] with no explicit binding": base({ uses: [{ pack: "./p", as: "p" }] }),
    "a namespaced ref with no matching uses[] entry": base({
      uses: [{ pack: "./p", as: "p" }],
      bindings: { ci: { checks: ["q/correctness"] } },
    }),
    "duplicate uses[] namespace": base({
      uses: [{ pack: "./p", as: "p" }, { pack: "./q", as: "p" }],
      bindings: { ci: { checks: ["types"] } },
    }),
    "effects: true on an agent check": base({
      checks: [{ id: "a", kind: "agent", preset: "p", rubric: "./r.md", effects: true }],
    }),
    "an unpinned git pack": base({
      uses: [{ pack: "git+https://example.com/p.git#main", as: "p" }],
      bindings: { ci: { checks: ["types"] } },
    }),
    "a non-https git pack": base({
      uses: [{ pack: `git+ssh://example.com/p.git#${"a".repeat(40)}`, as: "p" }],
      bindings: { ci: { checks: ["types"] } },
    }),
    "an unknown key": base({ surprise: 1 }),
    "an invalid check id": base({ checks: [{ id: "Bad_Id", kind: "command", run: "x" }] }),
    "a non-positive timeout": base({ checks: [{ id: "a", kind: "command", run: "x", timeoutMs: 0 }] }),
    "no checks": base({ checks: [] }),
    "a wrong kind": base({ kind: "workflow" }),
  }

  for (const [label, def] of Object.entries(violations)) {
    it(`rejects ${label}, with the same diagnostic parseReviewManifest gives`, () => {
      let detail = ""
      try {
        checkAndBuild(def)
      } catch (e) {
        expect(e).toBeInstanceOf(ReviewManifestError)
        detail = (e as ReviewManifestError).detail
      }
      expect(detail).not.toBe("")
      const md = `---\n${JSON.stringify(def)}\n---\n`
      expect(() => parseReviewManifest(md)).toThrow(`parseReviewManifest: ${detail}`)
      expect(() => defineReview(def)).toThrow(`defineReview (AIP-62): ${detail}`)
    })
  }

  it("a definition that is not even an object fails with the schema's diagnostic", () => {
    expect(() => defineReview(null as unknown as ReviewDefinition)).toThrow(/defineReview \(AIP-62\): invalid frontmatter/)
  })
})

function checkAndBuild(def: ReviewDefinition): void {
  parseReviewManifest(`---\n${JSON.stringify(def)}\n---\n`)
}

describe("git pack refs (AIP-62: the pin starts at the first '#')", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567"

  it("splits url and sha", () => {
    expect(parseGitPackRef(`git+https://github.com/example/review-pack-a11y#${sha}`)).toEqual({
      url: "https://github.com/example/review-pack-a11y",
      sha,
    })
  })

  it("agrees with the schema's pattern on a '#' in the path: rejected", () => {
    const ref = `git+https://example.com/a#b/pack.git#${sha}`
    expect(() => parseGitPackRef(ref)).toThrow(GitPackRefError)
    expect(reviewFrontmatterSchema.safeParse({
      kind: "review",
      id: "x",
      target: "git-range",
      checks: [{ id: "a", kind: "command", run: "x" }],
      uses: [{ pack: ref, as: "p" }],
      bindings: { ci: { checks: ["a"] } },
    }).success).toBe(false)
  })

  it.each(["git+http://x.com/p#" + sha, "git+ssh://x.com/p#" + sha, "git+https://x.com/p#" + sha.slice(1), "git+https://x.com/p", "git+https://x.com/ p#" + sha])(
    "rejects %s",
    (ref) => {
      expect(() => parseGitPackRef(ref)).toThrow(GitPackRefError)
    },
  )
})
