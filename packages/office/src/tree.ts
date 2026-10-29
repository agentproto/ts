/**
 * AIP-22 "An office spans a company tree": the item-level and tree-level
 * rules the JSON Schema cannot express.
 *
 * Pure: the caller hands over the nodes of one AIP-34 tree (with the
 * OFFICE.md frontmatter each carries) and the items of the office, and gets
 * back every refusal and warning plus the lookups a host needs (the node of
 * a seat, the executor lens of a node). `readOfficeTree` in
 * `@agentproto/office/manifest` builds the input from a folder.
 */

import { officeFrontmatterSchema, type OfficeFrontmatter } from "./schema.js"

export interface OfficeTreeNodeInput {
  /** AIP-34 id of the node, e.g. `@acme/simone`. */
  ref: string
  /** Folder of the node, posix, relative to the tree root; "" for the root. */
  dir: string
  /** Raw OFFICE.md frontmatter, when the node carries an OFFICE.md. */
  office?: unknown
}

export interface OfficeItemInput {
  id: string
  collection: string
  [field: string]: unknown
}

export interface OfficeTreeInput {
  /** `ref` of the tree root (the company node). */
  root: string
  nodes: readonly OfficeTreeNodeInput[]
  items: readonly OfficeItemInput[]
}

export type OfficeTreeIssueCode =
  | "office_frontmatter_invalid"
  | "office_tree_root_missing"
  | "office_tree_second_root"
  | "office_extends_outside_tree"
  | "office_extends_missing"
  | "office_extends_cycle"
  | "company_extends_depth_exceeded"
  | "office_seat_parent_outside"
  | "office_orgtree_invalid_parent_kind"
  | "office_orgtree_max_depth"
  | "office_orgtree_cycle"
  | "office_reports_to_unresolvable"
  | "office_reports_to_cardinality"
  | "office_orgtree_circular_report"
  | "office_holder_unresolvable"

export interface OfficeTreeIssue {
  code: OfficeTreeIssueCode
  severity: "hard" | "warn"
  message: string
  node?: string
  item?: string
}

export type HolderRef =
  | { kind: "operator"; id: string; workspace?: string }
  | { kind: "user"; id: string; workspace?: string }

export interface OfficeSeat {
  id: string
  collection: string
  /** Node the seat belongs to: nearest `view` parent, else the company node. */
  node: string
  /** Parsed holder; undefined when the seat is unfilled or the ref is malformed. */
  holder?: HolderRef
  /** True when the holder is an operator the host resolved. A `user:` holder activates nothing. */
  activates: boolean
}

export interface OfficeTreeOptions {
  /** Host resolver for holders. Omitted: only the ref syntax is checked. */
  resolveHolder?: (holder: HolderRef) => boolean
}

export interface ExecutorLens {
  executor: string
  /** Node whose OFFICE.md set the executor. */
  from: string
}

export interface OfficeTreeAnalysis {
  /** No hard refusal. */
  ok: boolean
  issues: readonly OfficeTreeIssue[]
  seats: readonly OfficeSeat[]
  nodeOfSeat(seatId: string): string | undefined
  /** Executor of the lens of `nodeRef` (nearest view that sets one, else the root office's). */
  executorOf(nodeRef: string): ExecutorLens | undefined
}

const MAX_EXTENDS_DEPTH = 8
const VIEW_KIND = "view"
const SLUG = "[a-z][a-z0-9-]*"
const WORKSPACE = "[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*"
const COMPACT_HOLDER = new RegExp(
  `^(operator|user):([A-Za-z0-9][A-Za-z0-9._-]*)(?:@(${WORKSPACE}))?$`,
)
const WS_OPERATOR = new RegExp(`^ws://operators/(${SLUG})$`)

/** Parse a seat holder: `operator:<slug>[@o/s]`, `user:<id>[@o/s]` or `ws://operators/<slug>`. */
export function parseHolder(ref: unknown): HolderRef | undefined {
  if (typeof ref !== "string") return undefined
  const ws = WS_OPERATOR.exec(ref)
  if (ws) return { kind: "operator", id: ws[1]! }
  const m = COMPACT_HOLDER.exec(ref)
  if (!m) return undefined
  const kind = m[1] as "operator" | "user"
  if (kind === "operator" && !new RegExp(`^${SLUG}$`).test(m[2]!))
    return undefined
  return m[3]
    ? { kind, id: m[2]!, workspace: m[3] }
    : { kind, id: m[2]! }
}

/** Directory part of a posix path; "" for a top-level entry. */
const parentDir = (path: string): string => {
  const i = path.lastIndexOf("/")
  return i < 0 ? "" : path.slice(0, i)
}

/** Resolve `rel` against `dir`; undefined when it climbs above the tree root. */
const resolveRel = (dir: string, rel: string): string | undefined => {
  const out = dir === "" ? [] : dir.split("/")
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      if (out.pop() === undefined) return undefined
    } else out.push(seg)
  }
  return out.join("/")
}

const asList = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : typeof v === "string"
      ? [v]
      : []

export function analyzeOfficeTree(
  input: OfficeTreeInput,
  opts: OfficeTreeOptions = {},
): OfficeTreeAnalysis {
  const issues: OfficeTreeIssue[] = []
  const add = (i: OfficeTreeIssue) => issues.push(i)

  const nodeByRef = new Map(input.nodes.map((n) => [n.ref, n]))
  const nodeByDir = new Map(input.nodes.map((n) => [n.dir, n]))
  const offices = new Map<string, OfficeFrontmatter>()
  for (const n of input.nodes) {
    if (n.office === undefined) continue
    const parsed = officeFrontmatterSchema.safeParse(n.office)
    if (!parsed.success) {
      add({
        code: "office_frontmatter_invalid",
        severity: "hard",
        node: n.ref,
        message: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      })
      continue
    }
    const fm = parsed.data
    if (fm.appliesTo && fm.appliesTo.length > 0 && fm.extends == null) {
      add({
        code: "office_frontmatter_invalid",
        severity: "hard",
        node: n.ref,
        message: "appliesTo is non-empty: extends MUST be set",
      })
      continue
    }
    offices.set(n.ref, fm)
  }

  // One workspace-root office per tree, at the root node.
  const rootOffice = offices.get(input.root)
  if (nodeByRef.get(input.root)?.office === undefined) {
    add({
      code: "office_tree_root_missing",
      severity: "hard",
      node: input.root,
      message: "the tree root carries no OFFICE.md",
    })
  } else if (rootOffice?.extends !== undefined) {
    add({
      code: "office_tree_root_missing",
      severity: "hard",
      node: input.root,
      message: "the tree root OFFICE.md is a view (it sets extends)",
    })
  }
  for (const [ref, fm] of offices) {
    if (ref !== input.root && fm.extends === undefined) {
      add({
        code: "office_tree_second_root",
        severity: "hard",
        node: ref,
        message: `${ref} holds a workspace-root OFFICE.md; the tree root ${input.root} already is the office root, so this one must set extends`,
      })
    }
  }

  // extends chain of every view: leaf first, root last. `reachesRoot` is the
  // condition for a node to carry a usable view of this office.
  const chains = new Map<string, string[]>()
  const reachesRoot = new Set<string>([input.root])
  const resolveExtends = (
    from: OfficeTreeNodeInput,
    ext: string,
  ): OfficeTreeNodeInput | "outside" | undefined => {
    const target = resolveRel(from.dir, ext)
    if (target === undefined) return "outside"
    return nodeByDir.get(parentDir(target))
  }
  for (const [ref, fm] of offices) {
    const chain = [ref]
    chains.set(ref, chain)
    if (ref === input.root) continue
    const seen = new Set([ref])
    let cur = nodeByRef.get(ref)!
    let curFm: OfficeFrontmatter | undefined = fm
    let ok = true
    while (curFm?.extends !== undefined) {
      const next = resolveExtends(cur, curFm.extends)
      if (next === "outside") {
        add({
          code: "office_extends_outside_tree",
          severity: "hard",
          node: cur.ref,
          message: `extends ${curFm.extends} leaves the tree ${input.root}`,
        })
        ok = false
        break
      }
      if (next === undefined || !offices.has(next.ref)) {
        add({
          code: "office_extends_missing",
          severity: "warn",
          node: cur.ref,
          message: `extends ${curFm.extends} names no OFFICE.md of this tree; the local manifest is used alone`,
        })
        ok = false
        break
      }
      if (seen.has(next.ref)) {
        add({
          code: "office_extends_cycle",
          severity: "warn",
          node: cur.ref,
          message: `extends chain of ${ref} loops back to ${next.ref}`,
        })
        ok = false
        break
      }
      if (chain.length >= MAX_EXTENDS_DEPTH) {
        add({
          code: "company_extends_depth_exceeded",
          severity: "warn",
          node: ref,
          message: `extends chain of ${ref} is deeper than ${MAX_EXTENDS_DEPTH}`,
        })
        ok = false
        break
      }
      seen.add(next.ref)
      chain.push(next.ref)
      cur = next
      curFm = offices.get(next.ref)
    }
    if (ok && chain[chain.length - 1] === input.root) reachesRoot.add(ref)
  }

  // Items. Every rule axis is read from the root office. Resolving them
  // through the view chain (a view may narrow maxDepth) is deferred.
  const rules = rootOffice?.orgTree?.containment?.rules
  const containmentOn = rootOffice?.orgTree?.containment?.enabled !== false
  const parentField = rootOffice?.orgTree?.containment?.field ?? "parent"
  const allowedKinds = new Set(rules?.allowedKinds ?? [])
  const allowedParentKinds = rules?.allowedParentKinds ?? {}
  const maxDepth = rules?.maxDepth
  const reporting = rootOffice?.orgTree?.reporting
  const reportField = reporting?.field ?? "reportsTo"
  const cardinality = reporting?.cardinality ?? "single"
  const mustResolveTo = reporting?.rules?.mustResolveTo ?? "role"
  const circularBan = reporting?.rules?.circularBan ?? true

  const holderFieldOf = (collection: string): string | undefined => {
    for (const c of rootOffice?.collections ?? []) {
      const e = c as {
        name?: string
        alias?: string
        ownership?: { role?: string }
      }
      if ((e.alias ?? e.name) === collection && e.ownership?.role)
        return e.ownership.role
    }
    return collection === "role" ? "holder" : undefined
  }

  const itemById = new Map(input.items.map((i) => [i.id, i]))
  const viewParentNode = (ref: string): boolean =>
    ref !== input.root && nodeByRef.has(ref) && reachesRoot.has(ref)

  // Containment: validate the parent of every item of a participating kind,
  // and compute its node and depth.
  const nodeOf = new Map<string, string>()
  const depthOf = new Map<string, number>()
  const bad = new Set<string>()
  const resolveItem = (item: OfficeItemInput, trail: string[]): void => {
    if (nodeOf.has(item.id) || bad.has(item.id)) return
    const parent = item[parentField]
    if (parent === undefined || parent === null) {
      nodeOf.set(item.id, input.root)
      depthOf.set(item.id, 1)
      return
    }
    if (typeof parent !== "string") {
      bad.add(item.id)
      add({
        code: "office_seat_parent_outside",
        severity: "hard",
        item: item.id,
        message: `${parentField} of ${item.id} is not a ref`,
      })
      return
    }
    const matrix = allowedParentKinds[item.collection]
    if (parent.startsWith("workspace:")) {
      const ref = parent.slice("workspace:".length)
      if (!viewParentNode(ref)) {
        bad.add(item.id)
        add({
          code: "office_seat_parent_outside",
          severity: "hard",
          item: item.id,
          message: !nodeByRef.has(ref)
            ? `${parent} is a node of another tree, not of ${input.root}`
            : ref === input.root
              ? `${parent} is the company node, which holds the root office, not a view`
              : `${parent} carries no view whose extends chain reaches the office of ${input.root}`,
        })
        return
      }
      if (matrix && !matrix.includes(VIEW_KIND)) {
        bad.add(item.id)
        add({
          code: "office_orgtree_invalid_parent_kind",
          severity: "hard",
          item: item.id,
          message: `${item.collection} may not have a view as parent (allowedParentKinds: ${matrix.join(", ")})`,
        })
        return
      }
      nodeOf.set(item.id, ref)
      depthOf.set(item.id, 2)
      return
    }
    const target = itemById.get(parent)
    if (!target) {
      bad.add(item.id)
      add({
        code: "office_seat_parent_outside",
        severity: "hard",
        item: item.id,
        message: `parent ${parent} is not an item of this office`,
      })
      return
    }
    if (trail.includes(target.id) || target.id === item.id) {
      bad.add(item.id)
      add({
        code: "office_orgtree_cycle",
        severity: "hard",
        item: item.id,
        message: `containment chain of ${item.id} loops through ${target.id}`,
      })
      return
    }
    if (matrix && !matrix.includes(target.collection)) {
      bad.add(item.id)
      add({
        code: "office_orgtree_invalid_parent_kind",
        severity: "hard",
        item: item.id,
        message: `${item.collection} may not have a ${target.collection} as parent (allowedParentKinds: ${matrix.join(", ")})`,
      })
      return
    }
    resolveItem(target, [...trail, item.id])
    const n = nodeOf.get(target.id)
    const d = depthOf.get(target.id)
    if (n === undefined || d === undefined) {
      bad.add(item.id)
      return
    }
    nodeOf.set(item.id, n)
    depthOf.set(item.id, d + 1)
  }

  const tracked = containmentOn
    ? input.items.filter((i) => allowedKinds.has(i.collection))
    : []
  for (const item of tracked) resolveItem(item, [])
  if (maxDepth !== undefined) {
    for (const item of tracked) {
      const d = depthOf.get(item.id)
      if (d !== undefined && d > maxDepth) {
        add({
          code: "office_orgtree_max_depth",
          severity: "hard",
          item: item.id,
          message: `${item.id} sits at depth ${d}, deeper than maxDepth ${maxDepth} (a view parent counts as one level)`,
        })
      }
    }
  }

  // Reporting stays inside the office.
  if (reporting?.enabled) {
    const reportsOf = (item: OfficeItemInput) => asList(item[reportField])
    for (const item of input.items) {
      const targets = reportsOf(item)
      if (cardinality === "single" && targets.length > 1) {
        add({
          code: "office_reports_to_cardinality",
          severity: "hard",
          item: item.id,
          message: `${reportField} of ${item.id} names ${targets.length} managers; cardinality is single`,
        })
      }
      for (const target of targets) {
        const t = itemById.get(target)
        if (!t) {
          add({
            code: "office_reports_to_unresolvable",
            severity: "hard",
            item: item.id,
            message: `${reportField} ${target} is not an item of this office`,
          })
        } else if (t.collection !== mustResolveTo) {
          add({
            code: "office_reports_to_unresolvable",
            severity: "hard",
            item: item.id,
            message: `${reportField} ${target} is a ${t.collection}, not a ${mustResolveTo}`,
          })
        }
      }
    }
    if (circularBan) {
      const reported = new Set<string>()
      for (const item of input.items) {
        const stack = [...reportsOf(item)]
        const seen = new Set<string>()
        while (stack.length > 0) {
          const id = stack.pop()!
          if (id === item.id) {
            if (!reported.has(item.id)) {
              reported.add(item.id)
              add({
                code: "office_orgtree_circular_report",
                severity: "hard",
                item: item.id,
                message: `${reportField} chain of ${item.id} closes a cycle`,
              })
            }
            break
          }
          if (seen.has(id)) continue
          seen.add(id)
          const next = itemById.get(id)
          if (next) stack.push(...reportsOf(next))
        }
      }
    }
  }

  // Seats and holders.
  const seats: OfficeSeat[] = []
  for (const item of tracked) {
    const field = holderFieldOf(item.collection)
    if (field === undefined) continue
    const raw = item[field]
    if (bad.has(item.id)) continue
    const node = nodeOf.get(item.id) ?? input.root
    if (raw === undefined || raw === null) {
      seats.push({ id: item.id, collection: item.collection, node, activates: false })
      continue
    }
    const holder = parseHolder(raw)
    let resolvable = holder !== undefined
    if (holder === undefined) {
      add({
        code: "office_holder_unresolvable",
        severity: "warn",
        item: item.id,
        message: `${field} ${JSON.stringify(raw)} is not an operator:<slug>[@<owner>/<slug>], user:<id>[@<owner>/<slug>] or ws://operators/<slug> ref`,
      })
    } else if (opts.resolveHolder && !opts.resolveHolder(holder)) {
      resolvable = false
      add({
        code: "office_holder_unresolvable",
        severity: "warn",
        item: item.id,
        message: `${String(raw)} does not resolve; the seat stays unfilled`,
      })
    }
    seats.push({
      id: item.id,
      collection: item.collection,
      node,
      ...(holder && resolvable ? { holder } : {}),
      activates: resolvable && holder?.kind === "operator",
    })
  }

  // The lens of a node: its own OFFICE.md, else the nearest ancestor folder's.
  const lensNode = (nodeRef: string): string | undefined => {
    let dir = nodeByRef.get(nodeRef)?.dir
    if (dir === undefined) return undefined
    for (;;) {
      const n = nodeByDir.get(dir)
      if (n && offices.has(n.ref)) return n.ref
      if (dir === "") return undefined
      dir = parentDir(dir)
    }
  }
  const seatNode = new Map(seats.map((s) => [s.id, s.node]))

  return {
    ok: !issues.some((i) => i.severity === "hard"),
    issues,
    seats,
    nodeOfSeat: (id) => seatNode.get(id),
    executorOf(nodeRef) {
      const start = lensNode(nodeRef)
      if (start === undefined) return undefined
      const chain = reachesRoot.has(start)
        ? chains.get(start)!
        : [start]
      for (const ref of chain) {
        const executor = offices.get(ref)?.executor
        if (executor !== undefined) return { executor, from: ref }
      }
      return undefined
    },
  }
}
