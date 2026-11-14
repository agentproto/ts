import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { checkWorkspaceTree } from "../checker/check-tree.js"
import { writeWorkspaceManifest } from "../manifest/index.js"
import { writeTypesManifest } from "../types-registry.js"
import type { WorkspaceDefinition } from "../types.js"

let root: string

function node(dir: string, def: WorkspaceDefinition, body = ""): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "WORKSPACE.md"), writeWorkspaceManifest(def, body))
}

function minimalWorkMd(name: string, title: string): string {
  return `---\nschema: work.workspace/v2\nname: ${name}\ntitle: ${title}\ndescription: Tracks ${title}'s work items.\n---\n`
}

const TYPES = {
  schema: "workspace-types/v1" as const,
  types: {
    root: { parents: [], max_per_tree: 1 },
    company: { parents: ["root"], default_wall: "isolated" as const, requires_files: ["COMPANY.md"] },
    project: { parents: ["company"], default_wall: "isolated" as const },
    perso: { parents: ["root"], default_wall: "sealed" as const },
  },
}

/** A clean, fully-wired tree: root → agentik(company) → {simone, chatcommerce}(project). */
function buildValidTree(base: string): void {
  writeFileSync(join(base, "TYPES.md"), writeTypesManifest(TYPES))
  node(base, {
    schema: "workspace/v2",
    id: "@test/root",
    version: "1.0.0",
    name: "Root",
    type: "root",
    owner: { type: "user", id: "jeremy", slug: "jeremy" },
    storage: { inline: { provider: "local-fs", config: {} } },
    policy: { limits: [{ kind: "budget-usd-per-month", value: 400 }] },
  })
  const agentikDir = join(base, "agentik")
  node(agentikDir, {
    schema: "workspace/v2",
    id: "@test/agentik",
    version: "1.0.0",
    name: "Agentik",
    type: "company",
    owner: { type: "org", id: "agentik", slug: "jeremy" },
    storage: { inline: { provider: "local-fs", config: {} } },
    secrets: { file: ".secrets/SECRETS.md" },
    policy: { limits: [{ kind: "budget-usd-per-month", value: 250 }] },
  })
  writeFileSync(join(agentikDir, "COMPANY.md"), "---\nschema: agentcompanies/v1\nkind: company\nslug: agentik\nname: Agentik\nversion: '1.0.0'\n---\n")
  mkdirSync(join(agentikDir, ".secrets"), { recursive: true })
  writeFileSync(
    join(agentikDir, ".secrets", "SECRETS.md"),
    `---\nsecrets:\n  - slug: stripe-key\n    name: Stripe\n    description: Payments.\n    access:\n      bind:\n        - workspace: "@test/chatcommerce"\n---\n`,
  )

  const simoneDir = join(agentikDir, "simone")
  node(
    simoneDir,
    {
      schema: "workspace/v2",
      id: "@test/simone",
      version: "1.0.0",
      name: "Simone",
      type: "project",
      owner: { type: "org", id: "agentik", slug: "jeremy" },
      storage: { inline: { provider: "local-fs", config: {} } },
      work: { file: "WORK.md" },
      exports: [{ path: "docs/whatsapp-flows", to: "@test/chatcommerce", mode: "read" }],
      policy: { limits: [{ kind: "budget-usd-per-month", value: 80 }] },
    },
  )
  writeFileSync(join(simoneDir, "WORK.md"), minimalWorkMd("simone", "Simone"))

  const ccDir = join(agentikDir, "chatcommerce")
  node(ccDir, {
    schema: "workspace/v2",
    id: "@test/chatcommerce",
    version: "1.0.0",
    name: "ChatCommerce",
    type: "project",
    owner: { type: "org", id: "agentik", slug: "jeremy" },
    storage: { inline: { provider: "local-fs", config: {} } },
    work: { file: "WORK.md" },
    includes: [{ ref: "ws://workspaces/@test/simone#docs/whatsapp-flows", mode: "read" }],
    uses_secrets: [{ from: "@test/agentik", slug: "stripe-key", mode: "bind" }],
    policy: { limits: [{ kind: "budget-usd-per-month", value: 60 }] },
  })
  writeFileSync(join(ccDir, "WORK.md"), minimalWorkMd("chatcommerce", "ChatCommerce"))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentproto-ws-check-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("checkWorkspaceTree — valid tree", () => {
  it("reports ok:true with no errors, 4 nodes, resolved budgets", () => {
    buildValidTree(root)
    const report = checkWorkspaceTree(root)
    expect(report.ok).toBe(true)
    expect(report.findings.filter((f) => f.level === "error")).toHaveLength(0)
    expect(report.nodeCount).toBe(4)
    const chatcommerce = report.nodes.find((n) => n.id === "@test/chatcommerce")
    expect(chatcommerce?.effectiveBudgetUsdPerMonth).toBe(60)
    expect(chatcommerce?.parentId).toBe("@test/agentik")
  })

  it("defaults every node's status/effectiveStatus to active with no statusInheritedFrom", () => {
    buildValidTree(root)
    const report = checkWorkspaceTree(root)
    for (const node of report.nodes) {
      expect(node.status).toBe("active")
      expect(node.effectiveStatus).toBe("active")
      expect(node.statusInheritedFrom).toBeUndefined()
    }
  })
})

describe("checkWorkspaceTree — status inheritance is reported, never an error or warning", () => {
  it("a paused company still reports 0 errors/warnings, with its active children effectively paused", () => {
    buildValidTree(root)
    writeFileSync(
      join(root, "agentik", "WORKSPACE.md"),
      writeWorkspaceManifest({
        schema: "workspace/v2",
        id: "@test/agentik",
        version: "1.0.0",
        name: "Agentik",
        type: "company",
        status: "paused",
        owner: { type: "org", id: "agentik", slug: "jeremy" },
        storage: { inline: { provider: "local-fs", config: {} } },
        secrets: { file: ".secrets/SECRETS.md" },
        policy: { limits: [{ kind: "budget-usd-per-month", value: 250 }] },
      }),
    )
    const report = checkWorkspaceTree(root)
    expect(report.ok).toBe(true)
    expect(report.findings.filter((f) => f.level === "error" || f.level === "warning")).toHaveLength(0)

    const agentik = report.nodes.find((n) => n.id === "@test/agentik")
    expect(agentik?.status).toBe("paused")
    expect(agentik?.effectiveStatus).toBe("paused")
    expect(agentik?.statusInheritedFrom).toBeUndefined()

    const simone = report.nodes.find((n) => n.id === "@test/simone")
    expect(simone?.status).toBe("active")
    expect(simone?.effectiveStatus).toBe("paused")
    expect(simone?.statusInheritedFrom).toBe("@test/agentik")
  })

  it("an active child under an archived root is effectively archived, and that is not an error", () => {
    buildValidTree(root)
    writeFileSync(
      join(root, "WORKSPACE.md"),
      writeWorkspaceManifest({
        schema: "workspace/v2",
        id: "@test/root",
        version: "1.0.0",
        name: "Root",
        type: "root",
        status: "archived",
        owner: { type: "user", id: "jeremy", slug: "jeremy" },
        storage: { inline: { provider: "local-fs", config: {} } },
        policy: { limits: [{ kind: "budget-usd-per-month", value: 400 }] },
      }),
    )
    const report = checkWorkspaceTree(root)
    expect(report.ok).toBe(true)
    expect(report.findings.filter((f) => f.level === "error")).toHaveLength(0)
    const chatcommerce = report.nodes.find((n) => n.id === "@test/chatcommerce")
    expect(chatcommerce?.effectiveStatus).toBe("archived")
    expect(chatcommerce?.statusInheritedFrom).toBe("@test/root")
  })
})

describe("checkWorkspaceTree — broken trees", () => {
  it("flags an include with no matching export as an error", () => {
    buildValidTree(root)
    // Remove simone's export — chatcommerce's include is now one-sided.
    const simoneWs = join(root, "agentik", "simone", "WORKSPACE.md")
    writeFileSync(
      simoneWs,
      writeWorkspaceManifest({
        schema: "workspace/v2",
        id: "@test/simone",
        version: "1.0.0",
        name: "Simone",
        type: "project",
        owner: { type: "org", id: "agentik", slug: "jeremy" },
        storage: { inline: { provider: "local-fs", config: {} } },
      }),
    )
    const report = checkWorkspaceTree(root)
    expect(report.ok).toBe(false)
    expect(
      report.findings.some(
        (f) => f.level === "error" && f.message.includes("door not accepted on the provider side"),
      ),
    ).toBe(true)
  })

  it("flags a literal secret value checked into SECRETS.md", () => {
    buildValidTree(root)
    writeFileSync(
      join(root, "agentik", ".secrets", "SECRETS.md"),
      `---\nsecrets:\n  - slug: stripe-key\n    name: Stripe\n    description: Payments.\n    value: sk-liveSECRETVALUE1234567890\n    access:\n      bind:\n        - workspace: "@test/chatcommerce"\n---\n`,
    )
    const report = checkWorkspaceTree(root)
    expect(report.ok).toBe(false)
    expect(
      report.findings.some((f) => f.level === "error" && f.message.includes("forbidden key")),
    ).toBe(true)
  })

  it("flags a wall looser than the type's TYPES.md floor", () => {
    buildValidTree(root)
    const persoDir = join(root, "perso")
    node(persoDir, {
      schema: "workspace/v2",
      id: "@test/perso",
      version: "1.0.0",
      name: "Perso",
      type: "perso",
      wall: "isolated", // TYPES.md says perso's floor is "sealed"
      owner: { type: "user", id: "jeremy", slug: "jeremy" },
      storage: { inline: { provider: "local-fs", config: {} } },
    })
    const report = checkWorkspaceTree(root)
    expect(report.ok).toBe(false)
    expect(
      report.findings.some(
        (f) => f.level === "error" && f.message.includes('looser than the "perso" type\'s floor "sealed"'),
      ),
    ).toBe(true)
  })

  it("reports a TYPES.md extends cycle as an error instead of overflowing the stack", () => {
    buildValidTree(root)
    writeFileSync(
      join(root, "TYPES.md"),
      writeTypesManifest({
        ...TYPES,
        types: { ...TYPES.types, alpha: { extends: "beta" }, beta: { extends: "alpha" } },
      }),
    )
    const report = checkWorkspaceTree(root)
    expect(report.ok).toBe(false)
    expect(report.findings.some((f) => f.level === "error" && f.message.includes("`extends` cycle"))).toBe(true)
  })

  it("reports a TYPES.md extends naming an undeclared type as an error", () => {
    buildValidTree(root)
    writeFileSync(
      join(root, "TYPES.md"),
      writeTypesManifest({ ...TYPES, types: { ...TYPES.types, guild: { extends: "projet" } } }),
    )
    const report = checkWorkspaceTree(root)
    expect(report.ok).toBe(false)
    expect(
      report.findings.some((f) => f.level === "error" && f.message.includes('extends "projet", which TYPES.md does not declare')),
    ).toBe(true)
  })

  it("flags a missing required file (COMPANY.md) for type company", () => {
    buildValidTree(root)
    rmSync(join(root, "agentik", "COMPANY.md"))
    const report = checkWorkspaceTree(root)
    expect(report.ok).toBe(false)
    expect(
      report.findings.some(
        (f) => f.level === "error" && f.message.includes("required file COMPANY.md is missing"),
      ),
    ).toBe(true)
  })

  it("flags a work: file that doesn't resolve to a valid WORK.md", () => {
    buildValidTree(root)
    writeFileSync(join(root, "agentik", "simone", "WORK.md"), "not frontmatter at all")
    const report = checkWorkspaceTree(root)
    expect(report.ok).toBe(false)
    expect(
      report.findings.some(
        (f) => f.level === "error" && f.nodeId === "@test/simone" && f.message.includes("work.file does not resolve to a valid WORK.md"),
      ),
    ).toBe(true)
  })

  it("flags a work: file that is simply missing", () => {
    buildValidTree(root)
    rmSync(join(root, "agentik", "chatcommerce", "WORK.md"))
    const report = checkWorkspaceTree(root)
    expect(report.ok).toBe(false)
    expect(
      report.findings.some(
        (f) => f.level === "error" && f.nodeId === "@test/chatcommerce" && f.message.includes("work.file does not resolve"),
      ),
    ).toBe(true)
  })

  it("reports a finding, never throws, when work.file is not a string", () => {
    buildValidTree(root)
    writeFileSync(
      join(root, "agentik", "simone", "WORKSPACE.md"),
      writeWorkspaceManifest({
        schema: "workspace/v2",
        id: "@test/simone",
        version: "1.0.0",
        name: "Simone",
        type: "project",
        owner: { type: "org", id: "agentik", slug: "jeremy" },
        storage: { inline: { provider: "local-fs", config: {} } },
        work: { file: 123 },
      }),
    )
    let report: ReturnType<typeof checkWorkspaceTree> | undefined
    expect(() => {
      report = checkWorkspaceTree(root)
    }).not.toThrow()
    expect(
      report?.findings.some(
        (f) => f.level === "error" && f.nodeId === "@test/simone" && f.message.includes("work.file must be a string path, got number"),
      ),
    ).toBe(true)
  })

  it("reports a finding, never throws, when work: itself is not an object", () => {
    buildValidTree(root)
    writeFileSync(
      join(root, "agentik", "simone", "WORKSPACE.md"),
      writeWorkspaceManifest({
        schema: "workspace/v2",
        id: "@test/simone",
        version: "1.0.0",
        name: "Simone",
        type: "project",
        owner: { type: "org", id: "agentik", slug: "jeremy" },
        storage: { inline: { provider: "local-fs", config: {} } },
        work: "not-an-object",
      }),
    )
    let report: ReturnType<typeof checkWorkspaceTree> | undefined
    expect(() => {
      report = checkWorkspaceTree(root)
    }).not.toThrow()
    expect(
      report?.findings.some(
        (f) => f.level === "error" && f.nodeId === "@test/simone" && f.message.includes("must be an object with one of inline/ref/file, got string"),
      ),
    ).toBe(true)
  })

  it("validates work.inline directly against workFrontmatterSchema", () => {
    buildValidTree(root)
    writeFileSync(
      join(root, "agentik", "simone", "WORKSPACE.md"),
      writeWorkspaceManifest({
        schema: "workspace/v2",
        id: "@test/simone",
        version: "1.0.0",
        name: "Simone",
        type: "project",
        owner: { type: "org", id: "agentik", slug: "jeremy" },
        storage: { inline: { provider: "local-fs", config: {} } },
        work: {
          inline: {
            schema: "work.workspace/v2",
            name: "simone",
            title: "Simone",
            description: "Simone's board.",
          },
        },
      }),
    )
    const report = checkWorkspaceTree(root)
    expect(report.findings.some((f) => f.nodeId === "@test/simone" && f.level === "error")).toBe(false)
  })

  it("flags an invalid work.inline frontmatter", () => {
    buildValidTree(root)
    writeFileSync(
      join(root, "agentik", "simone", "WORKSPACE.md"),
      writeWorkspaceManifest({
        schema: "workspace/v2",
        id: "@test/simone",
        version: "1.0.0",
        name: "Simone",
        type: "project",
        owner: { type: "org", id: "agentik", slug: "jeremy" },
        storage: { inline: { provider: "local-fs", config: {} } },
        work: { inline: { schema: "work.workspace/v2", name: "simone" } }, // missing title/description
      }),
    )
    const report = checkWorkspaceTree(root)
    expect(report.ok).toBe(false)
    expect(
      report.findings.some(
        (f) => f.level === "error" && f.nodeId === "@test/simone" && f.message.includes("work.inline is not a valid WORK.md frontmatter"),
      ),
    ).toBe(true)
  })

  it("reports work.ref as an info-level, unresolved-by-this-check finding", () => {
    buildValidTree(root)
    writeFileSync(
      join(root, "agentik", "simone", "WORKSPACE.md"),
      writeWorkspaceManifest({
        schema: "workspace/v2",
        id: "@test/simone",
        version: "1.0.0",
        name: "Simone",
        type: "project",
        owner: { type: "org", id: "agentik", slug: "jeremy" },
        storage: { inline: { provider: "local-fs", config: {} } },
        work: { ref: "@agentik/simone-board" },
      }),
    )
    const report = checkWorkspaceTree(root)
    expect(report.findings.some((f) => f.nodeId === "@test/simone" && f.level === "error")).toBe(false)
    expect(
      report.findings.some(
        (f) => f.level === "info" && f.nodeId === "@test/simone" && f.message.includes('work.ref "@agentik/simone-board"'),
      ),
    ).toBe(true)
  })

  it("does not require work: at all — a project without one is not an error", () => {
    buildValidTree(root)
    writeFileSync(
      join(root, "agentik", "simone", "WORKSPACE.md"),
      writeWorkspaceManifest({
        schema: "workspace/v2",
        id: "@test/simone",
        version: "1.0.0",
        name: "Simone",
        type: "project",
        owner: { type: "org", id: "agentik", slug: "jeremy" },
        storage: { inline: { provider: "local-fs", config: {} } },
      }),
    )
    const report = checkWorkspaceTree(root)
    expect(report.findings.some((f) => f.nodeId === "@test/simone" && f.level === "error")).toBe(false)
  })

  it("warns (does not error) when a child's declared budget exceeds its resolved ancestor ceiling", () => {
    buildValidTree(root)
    const ccWs = join(root, "agentik", "chatcommerce", "WORKSPACE.md")
    writeFileSync(
      ccWs,
      writeWorkspaceManifest({
        schema: "workspace/v2",
        id: "@test/chatcommerce",
        version: "1.0.0",
        name: "ChatCommerce",
        type: "project",
        owner: { type: "org", id: "agentik", slug: "jeremy" },
        storage: { inline: { provider: "local-fs", config: {} } },
        policy: { limits: [{ kind: "budget-usd-per-month", value: 999 }] },
      }),
    )
    const report = checkWorkspaceTree(root)
    const node = report.nodes.find((n) => n.id === "@test/chatcommerce")
    expect(node?.effectiveBudgetUsdPerMonth).toBe(250) // capped by agentik, not root's 400
    expect(
      report.findings.some((f) => f.level === "warning" && f.message.includes("effective ceiling is 250")),
    ).toBe(true)
    expect(report.findings.some((f) => f.level === "error")).toBe(false)
  })

  it("flags a secret use with no matching provider-side grant", () => {
    buildValidTree(root)
    writeFileSync(
      join(root, "agentik", ".secrets", "SECRETS.md"),
      `---\nsecrets:\n  - slug: stripe-key\n    name: Stripe\n    description: Payments.\n    access:\n      bind: []\n---\n`,
    )
    const report = checkWorkspaceTree(root)
    expect(report.ok).toBe(false)
    expect(
      report.findings.some(
        (f) => f.level === "error" && f.message.includes("no matching access.bind[].workspace grant"),
      ),
    ).toBe(true)
  })

  it("stays quiet about required-file freshness under the threshold, loud over it", () => {
    buildValidTree(root)
    const companyPath = join(root, "agentik", "COMPANY.md")
    const old = new Date(Date.now() - 1000 * 3600 * 100) // 100h ago
    utimesSync(companyPath, old, old)
    const report = checkWorkspaceTree(root, { maxReportAgeHours: 48 })
    expect(report.findings.some((f) => f.level === "warning" && f.message.includes("is stale"))).toBe(true)
  })

  it("treats a workspace/v1 node as a hard error — AIP-34 is workspace/v2 only", () => {
    buildValidTree(root)
    const legacyDir = join(root, "legacy")
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(
      join(legacyDir, "WORKSPACE.md"),
      "---\nschema: workspace/v1\nid: \"@test/legacy\"\nversion: 1.0.0\nname: Legacy\nowner: { type: user, id: jeremy, slug: jeremy }\nstorage: { inline: { provider: local-fs, config: {} } }\n---\n",
    )
    const report = checkWorkspaceTree(root)
    expect(report.ok).toBe(false)
    expect(
      report.findings.some(
        (f) => f.level === "error" && f.path.includes("legacy") && f.message.includes("unrecognised `schema`"),
      ),
    ).toBe(true)
  })

  it("honours apps[].attach to another node when accepted_apps grants it", () => {
    buildValidTree(root)
    writeFileSync(
      join(root, "agentik", "simone", "WORKSPACE.md"),
      writeWorkspaceManifest({
        schema: "workspace/v2",
        id: "@test/simone",
        version: "1.0.0",
        name: "Simone",
        type: "project",
        owner: { type: "org", id: "agentik", slug: "jeremy" },
        storage: { inline: { provider: "local-fs", config: {} } },
        apps: [{ id: "@agentik/seo-crew", version: "^0.1.0", attach: "@test/chatcommerce" }],
      }),
    )
    writeFileSync(
      join(root, "agentik", "chatcommerce", "WORKSPACE.md"),
      writeWorkspaceManifest({
        schema: "workspace/v2",
        id: "@test/chatcommerce",
        version: "1.0.0",
        name: "ChatCommerce",
        type: "project",
        owner: { type: "org", id: "agentik", slug: "jeremy" },
        storage: { inline: { provider: "local-fs", config: {} } },
        accepted_apps: [{ from: "@test/simone", app: "@agentik/seo-crew" }],
      }),
    )
    const report = checkWorkspaceTree(root)
    expect(report.findings.some((f) => f.level === "error" && f.nodeId === "@test/simone")).toBe(false)
  })

  it("flags apps[].attach to another node with no accepted_apps grant", () => {
    buildValidTree(root)
    writeFileSync(
      join(root, "agentik", "simone", "WORKSPACE.md"),
      writeWorkspaceManifest({
        schema: "workspace/v2",
        id: "@test/simone",
        version: "1.0.0",
        name: "Simone",
        type: "project",
        owner: { type: "org", id: "agentik", slug: "jeremy" },
        storage: { inline: { provider: "local-fs", config: {} } },
        apps: [{ id: "@agentik/seo-crew", version: "^0.1.0", attach: "@test/chatcommerce" }],
      }),
    )
    const report = checkWorkspaceTree(root)
    expect(report.ok).toBe(false)
    expect(
      report.findings.some(
        (f) =>
          f.level === "error" &&
          f.nodeId === "@test/simone" &&
          f.message.includes("has no accepted_apps grant for @test/simone"),
      ),
    ).toBe(true)
  })

  it("flags a work.file that resolves outside the tree via a symlink", () => {
    buildValidTree(root)
    const outside = mkdtempSync(join(tmpdir(), "agentproto-outside-"))
    writeFileSync(join(outside, "SECRET_WORK.md"), minimalWorkMd("escaped", "Escaped"))
    symlinkSync(join(outside, "SECRET_WORK.md"), join(root, "agentik", "simone", "ESCAPE.md"))
    writeFileSync(
      join(root, "agentik", "simone", "WORKSPACE.md"),
      writeWorkspaceManifest({
        schema: "workspace/v2",
        id: "@test/simone",
        version: "1.0.0",
        name: "Simone",
        type: "project",
        owner: { type: "org", id: "agentik", slug: "jeremy" },
        storage: { inline: { provider: "local-fs", config: {} } },
        work: { file: "ESCAPE.md" },
      }),
    )
    const report = checkWorkspaceTree(root)
    expect(report.ok).toBe(false)
    expect(
      report.findings.some(
        (f) => f.level === "error" && f.nodeId === "@test/simone" && f.message.includes("resolves outside the tree root via a symlink"),
      ),
    ).toBe(true)
    rmSync(outside, { recursive: true, force: true })
  })
})
