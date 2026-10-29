import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { canonicalizeGround, loadNodeTree } from "../checker/index.js"
import {
  NodeScopeError,
  composeNodeChainPolicy,
  nodeChain,
  nodeProjection,
  resolveNodeScope,
  type NodeTree,
} from "../index.js"
import { writeWorkspaceManifest } from "../manifest/index.js"
import { writeTypesManifest } from "../types-registry.js"
import type { WorkspaceDefinition } from "../types.js"

let base: string

const TYPES = {
  schema: "workspace.types/v1" as const,
  types: {
    root: { parents: [], max_per_tree: 1 },
    perso: { parents: ["root"], default_wall: "sealed" as const },
    vault: { parents: ["company"], default_wall: "hard" as const },
    company: { parents: ["root"], default_wall: "isolated" as const },
    project: { parents: ["company"], default_wall: "isolated" as const },
    guild: { extends: "project" },
  },
}

function node(dir: string, id: string, type: string, extra: Partial<WorkspaceDefinition> = {}): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "WORKSPACE.md"),
    writeWorkspaceManifest({
      schema: "workspace/v2",
      id,
      version: "1.0.0",
      name: id,
      type,
      owner: { type: "org", id: "t", slug: "t" },
      storage: { inline: { provider: "local-fs", config: {} } },
      ...extra,
    } as WorkspaceDefinition),
  )
}

/**
 * @t/root
 *   perso (@t/perso, type perso: sealed floor, wall omitted)
 *     coach (@t/coach)
 *   agentik (@t/agentik)
 *     simone (@t/simone, guild)   exports/includes a door with katchy
 *       docs/deep                  plain folders, no WORKSPACE.md
 *     katchy (@t/katchy, guild)
 *     ops (@t/ops, project, wall: sealed)
 *     vault (@t/vault, type vault: hard floor)
 *       inner (@t/inner)
 */
function buildTree(root: string, policies: Record<string, unknown> = {}): void {
  writeFileSync(join(root, "TYPES.md"), writeTypesManifest(TYPES))
  const p = (id: string) => (policies[id] === undefined ? {} : { policy: policies[id] as never })
  node(root, "@t/root", "root", p("@t/root"))
  node(join(root, "perso"), "@t/perso", "perso", p("@t/perso"))
  node(join(root, "perso", "coach"), "@t/coach", "project", p("@t/coach"))
  node(join(root, "agentik"), "@t/agentik", "company", p("@t/agentik"))
  node(join(root, "agentik", "simone"), "@t/simone", "guild", {
    ...p("@t/simone"),
    includes: [{ ref: "ws://workspaces/@t/katchy", mode: "read" }],
  })
  mkdirSync(join(root, "agentik", "simone", "docs", "deep"), { recursive: true })
  node(join(root, "agentik", "katchy"), "@t/katchy", "guild", {
    ...p("@t/katchy"),
    exports: [{ path: "docs", to: "@t/simone", mode: "read" }],
  })
  node(join(root, "agentik", "ops"), "@t/ops", "project", { wall: "sealed", ...p("@t/ops") })
  node(join(root, "agentik", "vault"), "@t/vault", "vault", p("@t/vault"))
  node(join(root, "agentik", "vault", "inner"), "@t/inner", "project", p("@t/inner"))
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "aip34-node-scope-"))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

function load(policies?: Record<string, unknown>): NodeTree {
  buildTree(base, policies)
  return loadNodeTree(base)
}

function byId(tree: NodeTree, id: string) {
  const found = tree.nodes.find((n) => n.id === id)
  if (!found) throw new Error(`no node ${id}`)
  return found
}

describe("node scope of a ground (C3)", () => {
  it("a path inside a declared node's subfolder resolves to that node with the subpath", () => {
    const tree = load()
    const scope = resolveNodeScope(tree, join(tree.rootDir, "agentik", "simone", "docs", "deep"))
    expect(scope?.node.id).toBe("@t/simone")
    expect(scope?.subpath).toBe("docs/deep")
  })

  it("the node folder itself has an empty subpath", () => {
    const tree = load()
    const scope = resolveNodeScope(tree, join(tree.rootDir, "agentik", "simone"))
    expect(scope).toMatchObject({ subpath: "" })
    expect(scope?.node.id).toBe("@t/simone")
  })

  it("a subtree body with slashes resolves like the path", () => {
    const tree = load()
    const scope = resolveNodeScope(tree, "ws://workspaces/@t/agentik/simone/docs")
    expect(scope?.node.id).toBe("@t/simone")
    expect(scope?.subpath).toBe("docs")
  })

  it("a subtree of a folder without WORKSPACE.md belongs to the nearest declared ancestor", () => {
    const tree = load()
    mkdirSync(join(tree.rootDir, "agentik", "plain"), { recursive: true })
    const scope = resolveNodeScope(tree, "ws://workspaces/@t/agentik/plain/x")
    expect(scope?.node.id).toBe("@t/agentik")
    expect(scope?.subpath).toBe("plain/x")
  })

  it("accepts the compact spelling of the same ref", () => {
    const tree = load()
    const scope = resolveNodeScope(tree, "workspace:@t/simone/docs")
    expect(scope?.node.id).toBe("@t/simone")
    expect(scope?.subpath).toBe("docs")
  })

  it("a ref without a subtree is the workspace's own node", () => {
    const tree = load()
    expect(resolveNodeScope(tree, "ws://workspaces/@t/katchy")?.node.id).toBe("@t/katchy")
  })

  it("a ground in no declared node gives no node scope", () => {
    const tree = load()
    const outside = mkdtempSync(join(tmpdir(), "aip34-outside-"))
    try {
      expect(resolveNodeScope(tree, outside)).toBeUndefined()
      expect(resolveNodeScope(tree, "ws://workspaces/@other/ws/x")).toBeUndefined()
      expect(resolveNodeScope(tree, "github:owner/repo")).toBeUndefined()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("a tree with no WORKSPACE.md at its root leaves a loose folder unscoped", () => {
    const loose = join(base, "nodes")
    node(join(loose, "only"), "@t/only", "project")
    mkdirSync(join(loose, "stray"), { recursive: true })
    const tree = loadNodeTree(loose)
    expect(resolveNodeScope(tree, join(tree.rootDir, "stray"))).toBeUndefined()
    expect(resolveNodeScope(tree, join(tree.rootDir, "only", "x"))?.node.id).toBe("@t/only")
  })

  it("keeps a literal percent in a path segment instead of URI-decoding it", () => {
    const tree = load()
    mkdirSync(join(tree.rootDir, "agentik", "simone", "a%41"), { recursive: true })
    mkdirSync(join(tree.rootDir, "agentik", "simone", "aA"), { recursive: true })
    const literal = join(tree.rootDir, "agentik", "simone", "a%41")
    expect(resolveNodeScope(tree, literal)?.subpath).toBe("a%41")
    expect(resolveNodeScope(tree, join(tree.rootDir, "agentik", "simone", "100%"))?.subpath).toBe("100%")
    // A ref body is URI-encoded, so there `%41` does decode to `A`.
    expect(resolveNodeScope(tree, "ws://workspaces/@t/agentik/simone/a%41")?.subpath).toBe("aA")
  })

  it("refuses a malformed ground instead of treating it as unscoped", () => {
    const tree = load()
    expect(() => resolveNodeScope(tree, "ws://workspaces/@t/agentik/../perso")).toThrow(NodeScopeError)
    expect(() => resolveNodeScope(tree, "ws://workspaces/@t/agentik#docs")).toThrow(NodeScopeError)
    expect(() => resolveNodeScope(tree, "ws://workspaces/agentik")).toThrow(NodeScopeError)
    expect(() => resolveNodeScope(tree, `${tree.rootDir}/agentik/../perso`)).toThrow(NodeScopeError)
  })

  it("canonicalizes a path ground through a symlink to the node it really lies in", () => {
    const tree = load()
    symlinkSync(join(tree.rootDir, "agentik", "katchy"), join(tree.rootDir, "agentik", "simone", "docs", "link"))
    const viaLink = join(tree.rootDir, "agentik", "simone", "docs", "link", "notes")
    expect(resolveNodeScope(tree, viaLink)?.node.id).toBe("@t/simone")
    expect(resolveNodeScope(tree, canonicalizeGround(viaLink))?.node.id).toBe("@t/katchy")
  })
})

describe("node chain", () => {
  it("runs nearest first and stops at the tree root", () => {
    const tree = load()
    expect(nodeChain(tree, "@t/simone").map((n) => n.id)).toEqual(["@t/simone", "@t/agentik", "@t/root"])
    expect(nodeChain(tree, "@t/root").map((n) => n.id)).toEqual(["@t/root"])
  })

  it("ends at the root of the tree it is loaded from, not at a folder above it", () => {
    load()
    const company = loadNodeTree(join(base, "agentik"))
    expect(nodeChain(company, "@t/simone").map((n) => n.id)).toEqual(["@t/simone", "@t/agentik"])
  })

  it("never holds a sibling, a descendant, or a node reached through a door", () => {
    const tree = load()
    const ids = nodeChain(tree, "@t/simone").map((n) => n.id)
    expect(ids).not.toContain("@t/katchy")
    expect(ids).not.toContain("@t/perso")
    expect(ids).not.toContain("@t/inner")
  })

  it("reports each node's wall, including the floor of its type", () => {
    const tree = load()
    const chain = nodeChain(tree, "@t/coach")
    expect(chain.map((n) => [n.id, n.wall])).toEqual([
      ["@t/coach", "isolated"],
      ["@t/perso", "sealed"],
      ["@t/root", "isolated"],
    ])
    expect(byId(tree, "@t/perso").declaredWall).toBe("isolated")
  })

  it("resolves a type floor through extends", () => {
    const tree = load()
    expect(byId(tree, "@t/simone").type).toBe("guild")
    expect(byId(tree, "@t/vault").wall).toBe("hard")
  })

  it("refuses a node that is not in the tree", () => {
    expect(() => nodeChain(load(), "@t/nope")).toThrow(NodeScopeError)
  })
})

describe("memory projection cut (AIP-72 section 10)", () => {
  it("holds the whole chain when no wall cuts it", () => {
    const tree = load()
    const projection = nodeProjection(nodeChain(tree, "@t/simone"))
    expect(projection.nodes.map((n) => n.id)).toEqual(["@t/simone", "@t/agentik", "@t/root"])
    expect(projection.cutAt).toBeUndefined()
  })

  it("stops after the first sealed node, which is in", () => {
    const tree = load()
    const projection = nodeProjection(nodeChain(tree, "@t/coach"))
    expect(projection.nodes.map((n) => n.id)).toEqual(["@t/coach", "@t/perso"])
    expect(projection.cutAt?.id).toBe("@t/perso")
  })

  it("stops at a sealed wall declared on the node itself", () => {
    const tree = load()
    const projection = nodeProjection(nodeChain(tree, "@t/ops"))
    expect(projection.nodes.map((n) => n.id)).toEqual(["@t/ops"])
    expect(projection.cutAt?.id).toBe("@t/ops")
  })

  it("stops after the first hard node", () => {
    const tree = load()
    const projection = nodeProjection(nodeChain(tree, "@t/inner"))
    expect(projection.nodes.map((n) => n.id)).toEqual(["@t/inner", "@t/vault"])
    expect(projection.cutAt?.id).toBe("@t/vault")
  })
})

describe("policy follows the node chain", () => {
  it("keeps an ancestor deny next to a child allow, so the deny wins at evaluation", () => {
    const tree = load({
      "@t/agentik": { grants: [{ principal: "*", effect: "deny", actions: [{ action: "tool:invoke", scope: "agentproto/command_execute" }] }] },
      "@t/simone": { grants: [{ principal: "*", actions: [{ action: "tool:invoke", scope: "agentproto/command_execute" }] }] },
    })
    const composed = composeNodeChainPolicy(nodeChain(tree, "@t/simone"))
    expect(composed.denies.map((d) => d.nodeId)).toEqual(["@t/agentik"])
    expect(composed.allows.map((a) => a.nodeId)).toEqual(["@t/simone"])
  })

  it("a child cannot lift an ancestor default deny", () => {
    const tree = load({
      "@t/root": { default: "deny" },
      "@t/simone": { default: "allow" },
    })
    expect(composeNodeChainPolicy(nodeChain(tree, "@t/simone")).default).toBe("deny")
  })

  it("an ancestor default deny prevails whichever side declares allow", () => {
    const tree = load({ "@t/agentik": { default: "allow" }, "@t/root": { default: "deny" } })
    expect(composeNodeChainPolicy(nodeChain(tree, "@t/simone")).default).toBe("deny")
  })

  it("is deny when no node declares a default, allow only when declared and never denied", () => {
    expect(composeNodeChainPolicy(nodeChain(load(), "@t/simone")).default).toBe("deny")
    const tree = load({ "@t/agentik": { default: "allow" } })
    expect(composeNodeChainPolicy(nodeChain(tree, "@t/simone")).default).toBe("allow")
  })

  it("applies every requirement of every node on the chain", () => {
    const tree = load({
      "@t/root": { requirements: [{ kind: "mfa-recent" }] },
      "@t/simone": { requirements: [{ kind: "signed-by" }] },
    })
    const composed = composeNodeChainPolicy(nodeChain(tree, "@t/simone"))
    expect(composed.requirements.map((r) => [r.nodeId, r.requirement.kind])).toEqual([
      ["@t/simone", "signed-by"],
      ["@t/root", "mfa-recent"],
    ])
  })

  it("returns the documents nearest first and reads only the chain", () => {
    const tree = load({
      "@t/root": { default: "deny" },
      "@t/simone": { default: "deny" },
      "@t/katchy": { grants: [{ principal: "*", effect: "deny", actions: [{ action: "x:y" }] }] },
      "@t/inner": { grants: [{ principal: "*", effect: "deny", actions: [{ action: "x:z" }] }] },
    })
    const composed = composeNodeChainPolicy(nodeChain(tree, "@t/simone"))
    expect(composed.documents.map((d) => d.nodeId)).toEqual(["@t/simone", "@t/root"])
    expect(composed.denies).toEqual([])
  })

  it("refuses a malformed policy block instead of ignoring it", () => {
    const tree = load({ "@t/agentik": { default: "maybe" } })
    expect(() => composeNodeChainPolicy(nodeChain(tree, "@t/simone"))).toThrow(NodeScopeError)
  })
})
