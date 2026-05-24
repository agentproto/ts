/**
 * Playbook system: registry + resolver + lifecycle.
 *
 * Uses the `landing-page-copy/PLAYBOOK.md` fixture so the tests stay
 * anchored to real AIP-12 conformant data.
 */

import { describe, expect, it } from "vitest"
import { CorpusWorkspaceReader } from "../workspace/reader.js"
import { PlaybookRegistry } from "../playbooks/registry.js"
import {
  OperatorOverlayResolver,
  renderOverlays,
} from "../playbooks/resolver.js"
import {
  PlaybookLifecycle,
  PlaybookNotFoundError,
  IllegalPlaybookTransitionError,
} from "../playbooks/lifecycle.js"
import type { ClockPort } from "../ports/clock.port.js"
import type { IdentityPort } from "../ports/identity.port.js"
import { loadMarketingFixtureFs, MemoryFs } from "./_helpers/memory-fs.js"

const fixedClock: ClockPort = {
  now: () => new Date("2026-05-22T15:00:00.000Z"),
  nowMs: () => Date.parse("2026-05-22T15:00:00.000Z"),
}
const stubIdentity: IdentityPort = {
  resolve: async () => ({
    principal: "ws://operators/corpus-curator",
    identityTree: ["ws://operators/corpus-curator"],
  }),
}

// ── Registry ────────────────────────────────────────────────────────

describe("PlaybookRegistry", () => {
  it("loads the marketing fixture playbooks with correct typed fields", async () => {
    const fs = await loadMarketingFixtureFs()
    const snapshot = await new CorpusWorkspaceReader({ fs }).read("")
    const reg = new PlaybookRegistry({ snapshot })
    // The marketing preset ships 5 shadow playbooks for the
    // marketing-analyst operator. landing-page-copy is the headliner;
    // the rest (ad-angle, competitor-positioning, cold-email,
    // social-hook) are also shadow with the same default shape.
    expect(reg.list().length).toBe(5)
    const p = reg.bySlugOrNull("landing-page-copy")
    expect(p).not.toBeNull()
    expect(p!.title).toBe("Landing-page copy — high-conversion structure")
    expect(p!.status).toBe("shadow")
    expect(p!.kind).toBe("overlay")
    expect(p!.priority).toBe(100)
    expect(p!.bindsOperator).toBe("marketing-analyst")
    expect(p!.targets.length).toBe(1)
    expect(p!.targets[0]).toEqual({
      kind: "operator",
      ref: "marketing-analyst",
    })
    expect(p!.corpus.shadowTrafficPct).toBe(0.1)
    expect(p!.corpus.execution).toBe("sandboxed")
    expect(p!.corpus.autoPromote?.enabled).toBe(true)
  })

  it("listBy filters by status, kind, target operator", async () => {
    const fs = await loadMarketingFixtureFs()
    const snapshot = await new CorpusWorkspaceReader({ fs }).read("")
    const reg = new PlaybookRegistry({ snapshot })
    expect(reg.listBy({ status: "shadow" }).length).toBe(5)
    expect(reg.listBy({ status: "active" }).length).toBe(0)
    expect(reg.listBy({ kind: "overlay" }).length).toBe(5)
    expect(reg.listBy({ kind: "block-replacement" }).length).toBe(0)
    expect(reg.listBy({ forOperatorSlug: "marketing-analyst" }).length).toBe(5)
    expect(reg.listBy({ forOperatorSlug: "sales-rep" }).length).toBe(0)
  })

  it("orders by priority descending", async () => {
    // Synthetic workspace with 3 playbooks targeting same operator.
    const fs = new MemoryFs({
      "KNOWLEDGE.md": fmYaml({
        schema: "knowledge.workspace/v1",
        name: "t",
        title: "T",
        description: "t",
        version: "1.0.0",
      }),
      "playbooks/a/PLAYBOOK.md": fmYaml({
        schema: "playbooks/v1",
        slug: "a",
        title: "A",
        targets: [{ kind: "operator", ref: "x" }],
        binds_operator: "x",
        kind: "overlay",
        status: "active",
        priority: 50,
        lock_check: [],
        evidence: [{ kind: "run", ref: "/r/1" }],
      }) + "\n## A overlay\n",
      "playbooks/b/PLAYBOOK.md": fmYaml({
        schema: "playbooks/v1",
        slug: "b",
        title: "B",
        targets: [{ kind: "operator", ref: "x" }],
        binds_operator: "x",
        kind: "overlay",
        status: "active",
        priority: 200,
        lock_check: [],
        evidence: [{ kind: "run", ref: "/r/2" }],
      }) + "\n## B overlay\n",
      "playbooks/c/PLAYBOOK.md": fmYaml({
        schema: "playbooks/v1",
        slug: "c",
        title: "C",
        targets: [{ kind: "operator", ref: "x" }],
        binds_operator: "x",
        kind: "overlay",
        status: "active",
        priority: 100,
        lock_check: [],
        evidence: [{ kind: "run", ref: "/r/3" }],
      }) + "\n## C overlay\n",
    })
    const snapshot = await new CorpusWorkspaceReader({ fs }).read("")
    const reg = new PlaybookRegistry({ snapshot })
    const slugs = reg.list().map((p) => p.slug)
    expect(slugs).toEqual(["b", "c", "a"])
  })
})

// ── Resolver ────────────────────────────────────────────────────────

describe("OperatorOverlayResolver", () => {
  it("returns active overlays for an operator unconditionally", async () => {
    const fs = new MemoryFs({
      "KNOWLEDGE.md": fmYaml({
        schema: "knowledge.workspace/v1",
        name: "t",
        title: "T",
        description: "t",
        version: "1.0.0",
      }),
      "playbooks/p/PLAYBOOK.md": fmYaml({
        schema: "playbooks/v1",
        slug: "p",
        title: "P",
        targets: [{ kind: "operator", ref: "x" }],
        binds_operator: "x",
        kind: "overlay",
        status: "active",
        lock_check: [],
        evidence: [{ kind: "run", ref: "/r" }],
      }) + "\n## P overlay body\n",
    })
    const snapshot = await new CorpusWorkspaceReader({ fs }).read("")
    const resolver = new OperatorOverlayResolver(
      new PlaybookRegistry({ snapshot })
    )
    const out = resolver.resolve({ operatorSlug: "x" })
    expect(out.overlays.length).toBe(1)
    expect(out.overlays[0]!.status).toBe("active")
    expect(out.overlays[0]!.shadowSampled).toBe(false)
  })

  it("sampling is deterministic per conversationId — same id always same arm", async () => {
    const fs = await loadMarketingFixtureFs()
    const snapshot = await new CorpusWorkspaceReader({ fs }).read("")
    const resolver = new OperatorOverlayResolver(
      new PlaybookRegistry({ snapshot })
    )
    // Sample a stable id 5x; same answer every time.
    const trials = [] as boolean[]
    for (let i = 0; i < 5; i++) {
      const out = resolver.resolve({
        operatorSlug: "marketing-analyst",
        conversationId: "conv-abc",
      })
      trials.push(out.overlays.length > 0)
    }
    expect(new Set(trials).size).toBe(1) // all same
  })

  it("shadow fires on ~shadowTrafficPct of conversations (independent per playbook)", async () => {
    const fs = await loadMarketingFixtureFs()
    const snapshot = await new CorpusWorkspaceReader({ fs }).read("")
    const resolver = new OperatorOverlayResolver(
      new PlaybookRegistry({ snapshot })
    )
    // The marketing fixture ships 5 shadow playbooks for marketing-analyst, each at
    // 10% — so P(at-least-one-fires) ≈ 1 - (0.9)^5 ≈ 0.41. We measure
    // a single specific playbook's hit rate to assert the 10% target
    // directly (independent of the operator's total playbook count).
    let landingPageOn = 0
    let anyOn = 0
    for (let i = 0; i < 1000; i++) {
      const out = resolver.resolve({
        operatorSlug: "marketing-analyst",
        conversationId: `conv-${i}`,
      })
      if (out.overlays.length > 0) anyOn++
      if (out.overlays.some((o) => o.playbookSlug === "landing-page-copy"))
        landingPageOn++
    }
    // Single playbook ≈ 10% (50..170)
    expect(landingPageOn).toBeGreaterThan(50)
    expect(landingPageOn).toBeLessThan(170)
    // Any-of-5 ≈ 41% (320..480)
    expect(anyOn).toBeGreaterThan(320)
    expect(anyOn).toBeLessThan(480)
  })

  it("renderOverlays concatenates overlays + lists block-replacements separately", async () => {
    const fs = new MemoryFs({
      "KNOWLEDGE.md": fmYaml({
        schema: "knowledge.workspace/v1",
        name: "t",
        title: "T",
        description: "t",
        version: "1.0.0",
      }),
      "playbooks/o/PLAYBOOK.md": fmYaml({
        schema: "playbooks/v1",
        slug: "o",
        title: "O",
        targets: [{ kind: "operator", ref: "x" }],
        binds_operator: "x",
        kind: "overlay",
        status: "active",
        lock_check: [],
        evidence: [{ kind: "run", ref: "/r" }],
      }) + "\n## Overlay block\n",
      "playbooks/br/PLAYBOOK.md": fmYaml({
        schema: "playbooks/v1",
        slug: "br",
        title: "BR",
        targets: [{ kind: "operator", ref: "x" }],
        binds_operator: "x",
        kind: "block-replacement",
        status: "active",
        lock_check: [],
        evidence: [{ kind: "run", ref: "/r2" }],
      }) + "\n## Replacement block\n",
    })
    const snapshot = await new CorpusWorkspaceReader({ fs }).read("")
    const resolver = new OperatorOverlayResolver(
      new PlaybookRegistry({ snapshot })
    )
    const out = resolver.resolve({ operatorSlug: "x" })
    const rendered = renderOverlays(out)
    expect(rendered.appendBlock).toContain("## Overlay block")
    expect(rendered.replacements.length).toBe(1)
    expect(rendered.replacements[0]!.playbookSlug).toBe("br")
  })
})

// ── Lifecycle ──────────────────────────────────────────────────────

describe("PlaybookLifecycle", () => {
  function tinyWorkspace(): MemoryFs {
    return new MemoryFs({
      "KNOWLEDGE.md": fmYaml({
        schema: "knowledge.workspace/v1",
        name: "t",
        title: "T",
        description: "t",
        version: "1.0.0",
      }),
      "playbooks/shadow-one/PLAYBOOK.md": fmYaml({
        schema: "playbooks/v1",
        slug: "shadow-one",
        title: "Shadow One",
        targets: [{ kind: "operator", ref: "x" }],
        binds_operator: "x",
        kind: "overlay",
        status: "shadow",
        lock_check: [],
        evidence: [{ kind: "run", ref: "/r" }],
        supersedes: ["old-active"],
      }) + "\n## Body\n",
      "playbooks/old-active/PLAYBOOK.md": fmYaml({
        schema: "playbooks/v1",
        slug: "old-active",
        title: "Old Active",
        targets: [{ kind: "operator", ref: "x" }],
        binds_operator: "x",
        kind: "overlay",
        status: "active",
        lock_check: [],
        evidence: [{ kind: "run", ref: "/r" }],
      }) + "\n## Body\n",
    })
  }

  it("activate flips shadow → active and supersedes previous active", async () => {
    const fs = tinyWorkspace()
    const lc = new PlaybookLifecycle({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspacePath: "",
    })
    const r = await lc.activate("shadow-one")
    expect(r.previousStatus).toBe("shadow")
    expect(r.supersededSlugs).toEqual(["old-active"])

    // Re-read both files to confirm state on disk
    const after = await new CorpusWorkspaceReader({ fs }).read("")
    const reg = new PlaybookRegistry({ snapshot: after })
    expect(reg.bySlugOrNull("shadow-one")?.status).toBe("active")
    expect(reg.bySlugOrNull("old-active")?.status).toBe("archived")
    expect(reg.bySlugOrNull("old-active")?.corpus.archiveReason).toBe(
      "superseded-by-shadow-one"
    )

    // _log.md has playbook.activated AND playbook.archived
    const log = await fs.readFile("_log.md")
    expect(log).toMatch(/playbook\.archived.*"slug":"old-active"/)
    expect(log).toMatch(/playbook\.activated.*"slug":"shadow-one"/)
  })

  it("archive flips → archived with reason", async () => {
    const fs = tinyWorkspace()
    const lc = new PlaybookLifecycle({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspacePath: "",
    })
    const r = await lc.archive("old-active", "test cleanup")
    expect(r.previousStatus).toBe("active")
    const after = await new CorpusWorkspaceReader({ fs }).read("")
    const reg = new PlaybookRegistry({ snapshot: after })
    expect(reg.bySlugOrNull("old-active")?.status).toBe("archived")
    expect(reg.bySlugOrNull("old-active")?.corpus.archiveReason).toBe(
      "test cleanup"
    )
  })

  it("archive on already-archived is a no-op", async () => {
    const fs = tinyWorkspace()
    const lc = new PlaybookLifecycle({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspacePath: "",
    })
    await lc.archive("old-active", "first")
    const r2 = await lc.archive("old-active", "second")
    expect(r2.previousStatus).toBe("archived")
  })

  it("activate refuses if already archived (terminal)", async () => {
    const fs = tinyWorkspace()
    const lc = new PlaybookLifecycle({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspacePath: "",
    })
    await lc.archive("shadow-one", "ditched")
    await expect(lc.activate("shadow-one")).rejects.toBeInstanceOf(
      IllegalPlaybookTransitionError
    )
  })

  it("activate on a missing slug throws PlaybookNotFoundError", async () => {
    const fs = tinyWorkspace()
    const lc = new PlaybookLifecycle({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspacePath: "",
    })
    await expect(lc.activate("ghost")).rejects.toBeInstanceOf(
      PlaybookNotFoundError
    )
  })
})

// ── Helpers ─────────────────────────────────────────────────────────

/** YAML-frontmatter helper for synthetic fixtures. */
function fmYaml(obj: Record<string, unknown>): string {
  const lines: string[] = ["---"]
  for (const [k, v] of Object.entries(obj)) {
    lines.push(`${k}: ${dumpYamlValue(v, 0)}`)
  }
  lines.push("---")
  return lines.join("\n")
}

function dumpYamlValue(v: unknown, depth: number): string {
  if (v === null || v === undefined) return "null"
  if (typeof v === "string") {
    // Quote everything to be safe for the fixture YAML parser.
    return JSON.stringify(v)
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]"
    const ind = "  ".repeat(depth + 1)
    return "\n" + v.map((x) => `${ind}- ${dumpYamlValue(x, depth + 1)}`).join("\n")
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
    if (entries.length === 0) return "{}"
    const ind = "  ".repeat(depth + 1)
    return (
      "\n" +
      entries
        .map(([k, val]) => `${ind}${k}: ${dumpYamlValue(val, depth + 1)}`)
        .join("\n")
    )
  }
  return JSON.stringify(v)
}
