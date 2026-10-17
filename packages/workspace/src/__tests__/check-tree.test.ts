import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { checkWorkspaceTree } from "../checker/check-tree.js"
import { writeWorkspaceV2Manifest } from "../manifest/v2.js"
import { writeTypesManifest } from "../types-registry.js"
import type { WorkspaceDefinitionV2 } from "../types-v2.js"

let root: string

function node(dir: string, def: WorkspaceDefinitionV2, body = ""): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "WORKSPACE.md"), writeWorkspaceV2Manifest(def, body))
}

function minimalWorkMd(name: string, title: string): string {
  return `---\nschema: work.workspace/v2\nname: ${name}\ntitle: ${title}\ndescription: Tracks ${title}'s work items.\nversion: 1.0.0\n---\n`
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
})

describe("checkWorkspaceTree — broken trees", () => {
  it("flags an include with no matching export as an error", () => {
    buildValidTree(root)
    // Remove simone's export — chatcommerce's include is now one-sided.
    const simoneWs = join(root, "agentik", "simone", "WORKSPACE.md")
    writeFileSync(
      simoneWs,
      writeWorkspaceV2Manifest({
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

  it("does not require work: at all — a project without one is not an error", () => {
    buildValidTree(root)
    writeFileSync(
      join(root, "agentik", "simone", "WORKSPACE.md"),
      writeWorkspaceV2Manifest({
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
      writeWorkspaceV2Manifest({
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
})
