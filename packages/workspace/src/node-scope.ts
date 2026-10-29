/**
 * AIP-34 node scope of a session, node chain, and the policy that follows
 * the chain. Pure: no filesystem access. A tree is loaded from disk by
 * `loadNodeTree` (`@agentproto/workspace/checker`); everything here works
 * on that data, so a host can also build a `NodeTree` from any other source.
 *
 * Spec: AIP-34 §Node scope of a session, §Policy follows the node chain,
 * §What `sealed` guarantees; AIP-72 §10 (node projection).
 */

export const WALL_LEVELS = ["shared", "isolated", "sealed", "hard"] as const
export type WallLevel = (typeof WALL_LEVELS)[number]

export function wallRank(wall: WallLevel): number {
  return WALL_LEVELS.indexOf(wall)
}

/** The stricter of two walls (higher level wins). */
export function strictestWall(a: WallLevel, b: WallLevel): WallLevel {
  return wallRank(a) >= wallRank(b) ? a : b
}

export interface TreeNode {
  /** AIP-34 id, `@<owner>/<slug>`. */
  id: string
  /** Tree-relative folder, `/`-separated, `""` for the tree root folder. */
  path: string
  type: string
  /** The `wall` written in the node's WORKSPACE.md (schema default: `isolated`). */
  declaredWall: WallLevel
  /**
   * The wall the host enforces: the stricter of `declaredWall` and the
   * `default_wall` floor of the node's type (TYPES.md, `extends` resolved).
   * A node whose wall is looser than its floor is a checker error; the host
   * still enforces the floor, never the looser value.
   */
  wall: WallLevel
  /** Id of the nearest declared ancestor (AIP-34 rule 1). Absent on a tree root. */
  parentId?: string
  /** The node's own `policy:` block as written, if any. */
  policy?: unknown
}

export interface NodeTree {
  /** Absolute folder of the tree root. */
  rootDir: string
  nodes: readonly TreeNode[]
}

export class NodeScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NodeScopeError"
  }
}

export interface NodeScope {
  node: TreeNode
  /** Folder of the ground inside the node, `/`-separated, `""` when the ground is the node folder. */
  subpath: string
}

const WORKSPACE_ID = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/

function isInside(folder: string, path: string): boolean {
  return folder === "" || path === folder || path.startsWith(`${folder}/`)
}

function cleanSegments(raw: string[], what: string): string[] {
  const out: string[] = []
  for (const part of raw) {
    let seg: string
    try {
      seg = decodeURIComponent(part)
    } catch {
      throw new NodeScopeError(`${what}: malformed percent-encoding in "${part}"`)
    }
    if (seg === "" || seg === "." || seg === ".." || seg.includes("/") || seg.includes("\\") || seg.includes("#")) {
      throw new NodeScopeError(`${what}: segment "${part}" is not a plain folder name (no empty, "." or ".." segment, no "#")`)
    }
    out.push(seg)
  }
  return out
}

/** Tree-relative folder for a ground, or `undefined` when it names a place outside the tree. */
function groundToTreePath(tree: NodeTree, ground: string): string | undefined {
  if (ground.startsWith("ws://") || /^workspace:/.test(ground)) {
    const body = ground.startsWith("ws://")
      ? (() => {
          const rest = ground.slice("ws://".length)
          const slash = rest.indexOf("/")
          const collection = slash === -1 ? rest : rest.slice(0, slash)
          if (collection !== "workspaces") return undefined
          return slash === -1 ? "" : rest.slice(slash + 1)
        })()
      : ground.slice("workspace:".length)
    if (body === undefined) return undefined
    const parts = body.split("/")
    const [owner, slug, ...subtree] = parts
    const id = `${owner}/${slug}`
    if (!WORKSPACE_ID.test(id)) throw new NodeScopeError(`ground "${ground}": workspace body must start with @<owner>/<slug>`)
    const base = tree.nodes.find((n) => n.id === id)
    if (!base) return undefined
    const sub = cleanSegments(subtree, `ground "${ground}"`)
    return [base.path, ...sub].filter((s) => s !== "").join("/")
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(ground)) return undefined

  const root = tree.rootDir.replace(/\/+$/, "")
  let rel: string
  if (ground.startsWith("/")) {
    if (ground === root) rel = ""
    else if (ground.startsWith(`${root}/`)) rel = ground.slice(root.length + 1)
    else return undefined
  } else {
    rel = ground
  }
  const parts = rel.split("/").filter((s) => s !== "" && s !== ".")
  return cleanSegments(parts, `ground "${ground}"`).join("/")
}

/**
 * The node scope of a session (C3): the nearest declared node whose folder
 * contains the session's AIP-46 `ground`, with the ground's subpath inside it.
 *
 * `ground` is an AIP-54 ref (`ws://workspaces/@acme/agentik/simone/docs`, or
 * the compact `workspace:@acme/agentik/simone/docs`; the subtree is the slash
 * body, no other syntax) or a path: absolute inside the tree root, or relative
 * to it. Returns `undefined` when no declared node contains the ground (a
 * ground outside the tree, another workspace, a non-workspace ref): no node
 * scope, so no wall applies (AIP-34 "No declared node, no node scope").
 * Throws `NodeScopeError` for a malformed ground (`..`, `#`, bad body) so a
 * caller refuses it instead of serving it unscoped.
 */
export function resolveNodeScope(tree: NodeTree, ground: string): NodeScope | undefined {
  const target = groundToTreePath(tree, ground)
  if (target === undefined) return undefined
  let best: TreeNode | undefined
  for (const node of tree.nodes) {
    if (!isInside(node.path, target)) continue
    if (!best || node.path.length > best.path.length) best = node
  }
  if (!best) return undefined
  const subpath = best.path === "" ? target : target.slice(best.path.length).replace(/^\//, "")
  return { node: best, subpath }
}

/**
 * The node chain of a node within its tree: the node itself, then each
 * ancestor by `parentId` (nearest first), ending at the tree root. It follows
 * parent links only, so a sibling, a descendant, or a node reached through a
 * door (`includes`/`exports`) is never in it. Each entry carries its wall.
 */
export function nodeChain(tree: NodeTree, node: TreeNode | string): TreeNode[] {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]))
  const start = typeof node === "string" ? byId.get(node) : byId.get(node.id)
  if (!start) throw new NodeScopeError(`node ${typeof node === "string" ? node : node.id} is not in this tree`)
  const chain: TreeNode[] = []
  const seen = new Set<string>()
  for (let cursor: TreeNode | undefined = start; cursor; cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined) {
    if (seen.has(cursor.id)) throw new NodeScopeError(`node chain of ${start.id} loops at ${cursor.id}`)
    seen.add(cursor.id)
    chain.push(cursor)
  }
  return chain
}

export interface NodeProjection {
  /** The nodes whose items the session may be shown, nearest first. */
  nodes: TreeNode[]
  /** The first `sealed` or `hard` node, when the projection was cut there. */
  cutAt?: TreeNode
}

/**
 * AIP-72 §10 node projection of a chain: the node and each ancestor up to the
 * tree root, stopping after the first node whose wall is `sealed` or `hard`
 * (that node is in, nothing above it is).
 */
export function nodeProjection(chain: readonly TreeNode[]): NodeProjection {
  const nodes: TreeNode[] = []
  for (const node of chain) {
    nodes.push(node)
    if (node.wall === "sealed" || node.wall === "hard") return { nodes, cutAt: node }
  }
  return { nodes }
}

// ---------------------------------------------------------------------------
// Policy follows the node chain (AIP-34), AIP-38 composition

export type PolicyDecision = "allow" | "deny"

export interface ChainPolicyDocument {
  nodeId: string
  /** The node's `policy:` block, validated for the fields composition reads. */
  policy: Record<string, unknown>
}

export interface OriginGrant {
  nodeId: string
  grant: Record<string, unknown>
}

export interface ComposedNodePolicy {
  /** Every policy block on the chain, nearest node first. This is the ordered input an AIP-38 evaluator consumes. */
  documents: ChainPolicyDocument[]
  /**
   * `deny` if ANY document declares `default: deny`, or if none declares a
   * default at all (AIP-38 rule 1). `allow` only when at least one document
   * declares `default: allow` and none declares `deny`.
   */
  default: PolicyDecision
  /** Grants with `effect` omitted or `allow`: the union over the chain. */
  allows: OriginGrant[]
  /** Grants with `effect: deny`. A matching one wins over every allow in `allows`, wherever declared. */
  denies: OriginGrant[]
  /** Every requirement of every document; all apply. */
  requirements: Array<{ nodeId: string; requirement: Record<string, unknown> }>
}

function recordList(doc: ChainPolicyDocument, key: string): Record<string, unknown>[] {
  const value = doc.policy[key]
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((v) => v === null || typeof v !== "object" || Array.isArray(v))) {
    throw new NodeScopeError(`policy of ${doc.nodeId}: \`${key}\` must be a list of objects`)
  }
  return value as Record<string, unknown>[]
}

/**
 * Composes the `policy:` of every node on `chain` once, under AIP-38: union of
 * allow grants, a matching deny anywhere wins, `default: deny` anywhere
 * prevails, every requirement applies. A node can add restrictions and allows
 * but cannot lift a deny, a default or a requirement declared on its chain.
 *
 * Only the chain is read: a sibling, a descendant, a door-reached node or the
 * operator's home node is never an input. The operator's own policy is composed
 * by the caller as a further document.
 *
 * This package has no AIP-38 evaluator to import (and may not touch
 * `@agentproto/policy`), so the result is the ordered documents plus the
 * partition an evaluator needs; deny-over-allow matching stays the evaluator's.
 */
export function composeNodeChainPolicy(chain: readonly TreeNode[]): ComposedNodePolicy {
  const documents: ChainPolicyDocument[] = []
  for (const node of chain) {
    if (node.policy === undefined || node.policy === null) continue
    if (typeof node.policy !== "object" || Array.isArray(node.policy)) {
      throw new NodeScopeError(`policy of ${node.id} must be an object`)
    }
    documents.push({ nodeId: node.id, policy: node.policy as Record<string, unknown> })
  }

  let sawAllow = false
  let sawDeny = false
  const allows: OriginGrant[] = []
  const denies: OriginGrant[] = []
  const requirements: ComposedNodePolicy["requirements"] = []

  for (const doc of documents) {
    const declared = doc.policy.default
    if (declared !== undefined) {
      if (declared === "deny") sawDeny = true
      else if (declared === "allow") sawAllow = true
      else throw new NodeScopeError(`policy of ${doc.nodeId}: \`default\` must be "allow" or "deny"`)
    }
    for (const grant of recordList(doc, "grants")) {
      const effect = grant.effect
      if (effect === undefined || effect === "allow") allows.push({ nodeId: doc.nodeId, grant })
      else if (effect === "deny") denies.push({ nodeId: doc.nodeId, grant })
      else throw new NodeScopeError(`policy of ${doc.nodeId}: grant \`effect\` must be "allow" or "deny"`)
    }
    for (const requirement of recordList(doc, "requirements")) requirements.push({ nodeId: doc.nodeId, requirement })
  }

  return { documents, default: sawAllow && !sawDeny ? "allow" : "deny", allows, denies, requirements }
}
