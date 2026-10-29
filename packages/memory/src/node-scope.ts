import { MemoryValidationError } from "./errors.js"
import type { MemoryScope } from "./store.js"
import type { MemoryDocument, MemoryFrontmatter } from "./types.js"

/**
 * AIP-72 section 10, as pure functions over a scope the host already
 * computed: the anchor tags, the projection conditions that need no clock
 * and no session anchors (2 node, 4 ownership), and the write defaults and
 * checks of rules 31 to 34. Nothing here reads a tree, a wall or a store.
 */

const NODE_PREFIX = "node:"
const OPERATOR_PREFIX = "operator:"

type Tagged = Pick<MemoryFrontmatter, "tags">

/** `node:<id>`, `id` being the AIP-34 id of a node (`@<owner>/<slug>`). */
export function nodeTag(id: string): string {
  return `${NODE_PREFIX}${id}`
}

/** `operator:<id>`, `id` being the body of an AIP-54 `operator:` ref. */
export function operatorTag(id: string): string {
  return `${OPERATOR_PREFIX}${id}`
}

function idsOf(tags: readonly string[] | undefined, prefix: string): string[] {
  const out: string[] = []
  for (const tag of tags ?? []) {
    if (tag.startsWith(prefix) && tag.length > prefix.length) out.push(tag.slice(prefix.length))
  }
  return out
}

/** The ids of the item's node anchors (an item carries at most one). */
export function nodeAnchorIds(item: Tagged): string[] {
  return idsOf(item.tags, NODE_PREFIX)
}

/** The ids of the item's operator anchors (an item carries at most one). */
export function operatorAnchorIds(item: Tagged): string[] {
  return idsOf(item.tags, OPERATOR_PREFIX)
}

/** Whether a tag is a node or operator anchor (neither counts as an anchor for section 9). */
export function isNodeOrOperatorTag(tag: string): boolean {
  return tag.startsWith(NODE_PREFIX) || tag.startsWith(OPERATOR_PREFIX)
}

export interface NodeProjectionOptions {
  /**
   * Operator anchor ids the store's AIP-38 read grants let the session
   * read (condition 4). A grant never extends condition 2.
   */
  grantedOperators?: Iterable<string>
}

/**
 * Conditions 2 and 4 of the node projection (section 10), the two that
 * read an item's node and operator anchors. Conditions 1 (in force) and 3
 * (the session's flat anchors) stay with the caller, which has the clock
 * and the anchors; the conditions are an intersection.
 *
 * - With a node scope the item must carry a node anchor, and every node
 *   anchor it carries must be in `scope.nodes`; an item with none is out.
 * - Without one, an item with a node anchor is out and one with none is
 *   judged by the other conditions alone.
 * - An operator anchor needs the session to run that operator, or a grant.
 */
export function isInNodeProjection(
  item: Tagged,
  scope: MemoryScope,
  opts: NodeProjectionOptions = {},
): boolean {
  const nodes = nodeAnchorIds(item)
  if (scope.nodes.length > 0) {
    if (nodes.length === 0) return false
    if (!nodes.every((n) => scope.nodes.includes(n))) return false
  } else if (nodes.length > 0) {
    return false
  }
  const owners = operatorAnchorIds(item)
  if (owners.length === 0) return true
  const granted = new Set(opts.grantedOperators ?? [])
  return owners.every((o) => o === scope.operator || granted.has(o))
}

export interface WriteScopeOptions {
  /** Rule 32. Default `"operator"`; `"node"` adds no operator anchor. */
  owner?: "operator" | "node"
  /**
   * The item this write replaces or supersedes. A document that names no
   * node anchor keeps the basis's, and a document that names no owner keeps
   * the basis's kind of ownership, so an edit never moves or hands over an
   * item by default (rule 34: nothing promotes an item by itself).
   */
  basis?: Tagged
  /** Rule 33: the host declares trees, so a document with no node anchor is refused. */
  declaresTrees?: boolean
}

function refuse(rule: string, message: string): never {
  throw new MemoryValidationError("memory scope (AIP-72 section 10)", [
    { path: "tags", message, rule },
  ])
}

/**
 * The document a write stores: the node and operator anchors added by
 * default (rules 31 to 33), or a validation error naming `tags`. `scope`
 * absent is a host call (rule 30): nothing is added or confined, but a
 * store whose host declares trees still refuses a document with no node
 * anchor (rule 33).
 */
export function applyWriteScope(
  item: MemoryDocument,
  scope: MemoryScope | undefined,
  opts: WriteScopeOptions = {},
): MemoryDocument {
  const tags = item.tags ?? []
  const nodes = nodeAnchorIds(item)
  const owners = operatorAnchorIds(item)
  if (nodes.length > 1) refuse("rule-31", "an item carries at most one node anchor")
  if (owners.length > 1) refuse("rule-32", "an item carries at most one operator anchor")

  const basisNodes = opts.basis ? nodeAnchorIds(opts.basis) : []
  const basisOwned = opts.basis ? operatorAnchorIds(opts.basis).length > 0 : true
  const add: string[] = []

  if (scope === undefined) {
    if (nodes.length === 0 && basisNodes[0] !== undefined) add.push(nodeTag(basisNodes[0]))
    if (nodes.length === 0 && add.length === 0 && opts.declaresTrees) {
      refuse("rule-33", "a document with no node anchor is refused where the host declares trees")
    }
    return add.length > 0 ? { ...item, tags: [...tags, ...add] } : item
  }

  const inScope = new Set(scope.nodes)
  for (const n of nodes) {
    if (!inScope.has(n)) refuse("rule-31", `node anchor '${n}' is outside the session's node projection`)
  }

  if (scope.nodes.length > 0) {
    if (tags.includes("global")) {
      if (nodes.some((n) => n !== scope.tree)) {
        refuse("rule-33", "a global item carries only the node anchor of the tree root")
      }
      if (nodes.length === 0) {
        if (scope.tree === undefined || !inScope.has(scope.tree)) {
          refuse("rule-33", "the tree root is not in the session's node projection, so it cannot write a global item")
        }
        add.push(nodeTag(scope.tree))
      }
    } else if (nodes.length === 0) {
      add.push(nodeTag(basisNodes[0] ?? (scope.nodes[0] as string)))
    }
  }

  for (const o of owners) {
    if (o !== scope.operator) refuse("rule-32", `operator anchor '${o}' is not the session's operator`)
  }
  if (owners.length > 0 && opts.owner === "node") {
    refuse("rule-32", "owner 'node' and an operator anchor contradict each other")
  }
  if (owners.length === 0 && scope.operator !== undefined) {
    const owner = opts.owner ?? (basisOwned ? "operator" : "node")
    if (owner === "operator") add.push(operatorTag(scope.operator))
  }

  return add.length > 0 ? { ...item, tags: [...tags, ...add] } : item
}

/**
 * Rule 34. A commit that moves an item to another node changes that anchor
 * and nothing else: not the operator anchor, not the other anchors. (That
 * the new node is in `scope.nodes` is `applyWriteScope`'s check; a node above
 * a sealed or hard wall never is, the projection being cut there.)
 */
export function assertRetagOnly(before: Tagged, after: Tagged): void {
  const was = nodeAnchorIds(before)[0]
  const now = nodeAnchorIds(after)[0]
  if (was === now) return
  const rest = (item: Tagged) =>
    [...new Set((item.tags ?? []).filter((t) => !t.startsWith(NODE_PREFIX)))].sort().join("\n")
  if (rest(before) !== rest(after)) {
    refuse("rule-34", "a re-tag moves the node anchor only: it changes neither the operator anchor nor the other anchors")
  }
}
