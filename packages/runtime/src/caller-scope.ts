/**
 * The caller's node scope, derived once and shared by every daemon read path
 * (memory tools and digest, file tools, app data, brain query, imported-call
 * gate).
 *
 * AIP-34 §Node scope of a session: the scope is read from the CALLER session's
 * AIP-46 ground (here `SessionDescriptor.cwd`), never from the configuration of
 * the server that executes the call. A call whose caller cannot be identified is
 * refused, never served unscoped. A call with no caller session at all on the
 * daemon's own authenticated surface is a host call and stays unscoped. A
 * session whose ground lies in no declared tree has no node scope and keeps
 * today's behaviour.
 *
 * `sealed` is a guarantee about what the host composes and returns, not an OS
 * wall, and the caller id is a claim (AIP-34 §What `sealed` guarantees).
 */

import { existsSync } from "node:fs"
import { dirname, isAbsolute, join, relative } from "node:path"
import type { MemoryScope } from "@agentproto/memory"
import {
  NodeScopeError,
  nodeChain,
  nodeProjection,
  resolveNodeScope,
  type NodeTree,
  type TreeNode,
} from "@agentproto/workspace"
import { canonicalizeGround, loadNodeTree } from "@agentproto/workspace/checker"
import { canonicalOperatorRef } from "./session-operator.js"

/** Per-call headers an imported http/sse MCP server receives (see `callerHeaders`). */
export const CALLER_SESSION_HEADER = "x-agentproto-caller-session"
export const CALLER_NODE_HEADER = "x-agentproto-caller-node"

export interface CallerNode {
  tree: NodeTree
  node: TreeNode
  /** The node, then each ancestor by parent link up to the tree root. */
  chain: readonly TreeNode[]
  /** AIP-72 section 10 projection: `chain` cut after the first sealed or hard node. */
  projection: readonly TreeNode[]
}

export type CallerScope =
  | { kind: "host" }
  | { kind: "refused"; reason: string }
  | {
      kind: "session"
      sessionId: string
      /** Canonical AIP-54 operator ref the session runs for (AIP-46 §Operator binding). */
      operator?: string
      /** Absent: the session's ground lies in no declared node, so no wall applies to it. */
      node?: CallerNode
    }

export const HOST_CALLER: CallerScope = Object.freeze({ kind: "host" })

export class CallerRefusedError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = "CallerRefusedError"
  }
}

/** Throws unless the caller may be served: a missing scope is refused like a refused one. */
export function assertServed(caller: CallerScope | undefined): asserts caller is Exclude<CallerScope, { kind: "refused" }> {
  if (caller === undefined) {
    throw new CallerRefusedError(
      "refused: the caller session cannot be identified, so no node scope can be derived (AIP-34: such a call is refused, never served unscoped).",
    )
  }
  if (caller.kind === "refused") throw new CallerRefusedError(caller.reason)
}

export interface SessionLookup {
  get(id: string): { cwd?: string; operator?: string } | undefined
}

export interface CallerScopesOptions {
  /** How long a loaded tree is reused. A WORKSPACE.md edited inside the window is seen after it. */
  treeTtlMs?: number
  now?: () => number
}

export const DEFAULT_TREE_TTL_MS = 5_000

interface LocatedNode {
  tree: NodeTree
  node: TreeNode
}

/** Topmost ancestor folder (including `dir`) that declares a WORKSPACE.md. */
function treeRootOf(dir: string): string | undefined {
  let top: string | undefined
  for (let cur = dir; ; cur = dirname(cur)) {
    if (existsSync(join(cur, "WORKSPACE.md"))) top = cur
    if (dirname(cur) === cur) break
  }
  return top
}

function operatorAnchor(operator: string | undefined): string | undefined {
  const canonical = operator === undefined ? undefined : canonicalOperatorRef(operator)
  return canonical?.slice("operator:".length)
}

const isWalled = (node: TreeNode): boolean => node.wall === "sealed" || node.wall === "hard"

/**
 * Whether a caller scoped to `caller` may be shown an item owned by `item`
 * (AIP-34 walls). Ancestors see descendants unless a sealed/hard node lies
 * between; a session sees itself and its ancestors up to the first sealed/hard
 * node; a `shared` sibling is readable by its siblings; anything else (another
 * branch, another tree) is outside the scope. Doors (`includes`/`exports`,
 * EXPORT.md) are not evaluated: they stay closed.
 */
export function nodeVisibleToCaller(caller: CallerNode, item: LocatedNode): boolean {
  if (item.tree.rootDir !== caller.tree.rootDir) return false
  if (caller.projection.some((n) => n.id === item.node.id)) return true
  const itemChain = nodeChain(item.tree, item.node)
  const callerIds = new Set(caller.chain.map((n) => n.id))
  const lcaIndex = itemChain.findIndex((n) => callerIds.has(n.id))
  if (lcaIndex < 0) return false
  const lca = itemChain[lcaIndex] as TreeNode
  const below = itemChain.slice(0, lcaIndex)
  if (lca.id === caller.node.id) return !below.some(isWalled)
  if (!caller.projection.some((n) => n.id === lca.id)) return false
  return below.length === 1 && (below[0] as TreeNode).wall === "shared"
}

export class CallerScopes {
  readonly #ttl: number
  readonly #now: () => number
  readonly #trees = new Map<string, { tree: NodeTree; at: number }>()

  constructor(opts: CallerScopesOptions = {}) {
    this.#ttl = opts.treeTtlMs ?? DEFAULT_TREE_TTL_MS
    this.#now = opts.now ?? Date.now
  }

  clear(): void {
    this.#trees.clear()
  }

  #tree(rootDir: string): NodeTree {
    const cached = this.#trees.get(rootDir)
    const now = this.#now()
    if (cached && now - cached.at < this.#ttl) return cached.tree
    const tree = loadNodeTree(rootDir)
    this.#trees.set(rootDir, { tree, at: now })
    return tree
  }

  /** The declared node that owns `path`, or undefined when no declared tree contains it. Throws when a tree cannot be read. */
  locate(path: string): LocatedNode | undefined {
    if (!isAbsolute(path)) throw new NodeScopeError(`path "${path}" is not absolute, so no node can be derived from it`)
    const ground = canonicalizeGround(path)
    const root = treeRootOf(ground)
    if (root === undefined) return undefined
    const tree = this.#tree(root)
    const scope = resolveNodeScope(tree, ground)
    return scope ? { tree, node: scope.node } : undefined
  }

  /** The scope of a session from its ground and operator. A ground the tree cannot place, or a tree that cannot be read, is refused. */
  ofSession(input: { sessionId: string; ground?: string; operator?: string }): CallerScope {
    const operator = input.operator === undefined ? undefined : canonicalOperatorRef(input.operator)
    const base = { kind: "session" as const, sessionId: input.sessionId, ...(operator ? { operator } : {}) }
    if (input.ground === undefined || input.ground.length === 0) return base
    try {
      const located = this.locate(input.ground)
      if (!located) return base
      const chain = nodeChain(located.tree, located.node)
      return { ...base, node: { tree: located.tree, node: located.node, chain, projection: nodeProjection(chain).nodes } }
    } catch (err) {
      return {
        kind: "refused",
        reason: `refused: the node scope of session '${input.sessionId}' cannot be derived (${
          err instanceof Error ? err.message : String(err)
        }).`,
      }
    }
  }

  /**
   * The caller of one gateway request. No `callerSessionId` is a host call
   * (the daemon's own authenticated surface); an id the daemon does not know
   * is refused.
   */
  resolve(callerSessionId: string | undefined, sessions: SessionLookup): CallerScope {
    if (callerSessionId === undefined || callerSessionId.length === 0) return HOST_CALLER
    const desc = sessions.get(callerSessionId)
    if (!desc) {
      return {
        kind: "refused",
        reason: `refused: caller session '${callerSessionId}' is not known to the daemon, so no node scope can be derived (AIP-34: such a call is refused, never served unscoped).`,
      }
    }
    return this.ofSession({
      sessionId: callerSessionId,
      ...(desc.cwd !== undefined ? { ground: desc.cwd } : {}),
      ...(desc.operator !== undefined ? { operator: desc.operator } : {}),
    })
  }

  /**
   * Whether `path` may be shown to the caller. A path outside every declared
   * tree is not walled. With `subtree`, every declared node strictly inside
   * `path` must be visible too (a recursive delete of a folder holding a
   * sealed node is a write into that node).
   */
  pathVisible(caller: CallerScope | undefined, path: string, opts: { subtree?: boolean } = {}): boolean {
    if (caller === undefined || caller.kind === "refused") return false
    if (caller.kind === "host" || caller.node === undefined) return true
    try {
      const located = this.locate(path)
      if (located === undefined) return true
      if (!nodeVisibleToCaller(caller.node, located)) return false
      if (opts.subtree) {
        const rel = relative(located.tree.rootDir, canonicalizeGround(path)).split("\\").join("/")
        const prefix = rel === "" ? "" : `${rel}/`
        for (const inner of located.tree.nodes) {
          if (inner.path === "" || !inner.path.startsWith(prefix) || inner.path === rel) continue
          if (!nodeVisibleToCaller(caller.node, { tree: located.tree, node: inner })) return false
        }
      }
      return true
    } catch {
      return false
    }
  }
}

/** The one instance the daemon shares between spawn, restart and the gateway. */
export const callerScopes = new CallerScopes()

/**
 * The AIP-72 section 10 scope handed to the memory store for a session
 * caller. A session with no node scope still gets one (`nodes: []`), the same
 * scope the spawn digest has always applied, so a tool answer and the digest
 * agree. A host call has none.
 */
export function memoryScopeOf(caller: CallerScope | undefined): MemoryScope | undefined {
  assertServed(caller)
  if (caller.kind === "host") return undefined
  const operator = operatorAnchor(caller.operator)
  const nodes = caller.node?.projection.map((n) => n.id) ?? []
  const tree = caller.node ? (caller.node.chain[caller.node.chain.length - 1] as TreeNode).id : undefined
  return { nodes, ...(tree !== undefined ? { tree } : {}), ...(operator !== undefined ? { operator } : {}) }
}

/**
 * The memory scope of a session derived from its own ground and operator (the
 * spawn digest and every respawn). Throws `CallerRefusedError` when the tree
 * cannot place the ground, so a digest is never built unscoped.
 */
export function sessionMemoryScope(
  input: { sessionId: string; ground?: string; operator?: string },
  scopes: CallerScopes = callerScopes,
): MemoryScope {
  const scope = memoryScopeOf(scopes.ofSession(input))
  if (scope === undefined) throw new CallerRefusedError("refused: a session scope is required")
  return scope
}

/** The headers an imported server receives for one call, or undefined for a host call. */
export function callerHeaders(caller: CallerScope): Record<string, string> | undefined {
  if (caller.kind !== "session") return undefined
  return {
    [CALLER_SESSION_HEADER]: caller.sessionId,
    ...(caller.node ? { [CALLER_NODE_HEADER]: caller.node.node.id } : {}),
  }
}
