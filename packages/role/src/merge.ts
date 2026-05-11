/**
 * AIP-47 strategic merge for role inheritance.
 *
 * Pure function: parent + child → merged. No I/O.
 *
 * Merge strategy per AIP-47 §Merge strategy table:
 *   - scalars (name/title/description/version/department/reports_to/
 *     seniority/mission/onPromotion/onDemotion/onAssign/defaultPersona/
 *     defaultIdentity/defaultPolicy): override (child wins)
 *   - list-strategy fields (responsibilities/capabilities/tools/skills/
 *     kpis/strengths/antiPatterns/tags): append-and-dedupe, OR
 *     `{ add, remove }` patch form
 *   - extends + appliesTo: local-only (never inherited)
 *   - metadata: deep-merge
 *
 * Body merge is handled by `mergeBodies` (separate concern — handles
 * `metadata['aip-47'].bodyMerge` switch).
 */

import type { RoleDefinition, RoleHandle } from "./types.js"

/**
 * A child role's input may carry a list patch on a list-strategy field
 * instead of a plain list. The patch is applied against the inherited
 * accumulator at merge time.
 *
 * See AIP-47 §Merge strategy →
 * "Explicit remove of inherited entries".
 */
export type ListPatch<T> = readonly T[] | { add?: readonly T[]; remove?: readonly T[] }

/**
 * The set of list-strategy field names per AIP-47 §Merge strategy.
 * Every entry here is an `append-and-dedupe` field that admits the
 * `{ add, remove }` patch form.
 */
export const LIST_FIELDS = [
  "responsibilities",
  "capabilities",
  "tools",
  "skills",
  "kpis",
  "strengths",
  "antiPatterns",
  "tags",
] as const

export type ListField = (typeof LIST_FIELDS)[number]

/**
 * The set of fields that are NEVER inherited from a parent role.
 * Used by the resolver to strip them before merging into the
 * accumulator.
 */
export const LOCAL_ONLY_FIELDS = ["extends", "appliesTo"] as const

/**
 * A child role's raw input. Same shape as `RoleDefinition` except
 * that list-strategy fields admit the `{ add, remove }` patch form.
 * The merger normalises patches into plain lists; the resolved output
 * is always `RoleHandle` (plain lists only).
 */
export type RoleChildInput = Omit<Partial<RoleDefinition>, ListField> & {
  [K in ListField]?: K extends "responsibilities"
    ? ListPatch<string> | [string, ...string[]]
    : ListPatch<string>
}

export type MergeWarning =
  | {
      code: "role_merge_form_conflict"
      message: string
      field: ListField
    }
  | {
      code: "role_merge_remove_missed"
      message: string
      field: ListField
      missing: string
    }

export interface MergeResult {
  /** The merged role frontmatter, always plain lists. */
  role: RoleHandle
  /** Diagnostics emitted during merge. */
  warnings: MergeWarning[]
}

/**
 * Apply a list patch onto an inherited accumulator.
 *
 * - If `child` is a plain array → REPLACE the inherited list entirely.
 * - If `child` is `{ add, remove }` → APPEND-AND-DEDUPE additions and
 *   exact-string-REMOVE inherited entries.
 * - If `child` is `undefined` → return the inherited accumulator as-is.
 *
 * The "replace" semantics for the plain-array form matches the
 * AIP-47 spec exactly: a child author writing the field in long form
 * (plain list) overrides the lineage; the `{ add, remove }` form is
 * the only way to patch.
 *
 * Returns the resolved list AND any warnings (e.g. `remove` entries
 * that did not match anything in the accumulator).
 */
function applyListPatch<T>(
  field: ListField,
  inherited: readonly T[],
  child: ListPatch<T> | undefined,
): { value: T[]; warnings: MergeWarning[] } {
  if (child === undefined) {
    return { value: [...inherited], warnings: [] }
  }

  // Plain array → replace.
  if (Array.isArray(child)) {
    return { value: [...child], warnings: [] }
  }

  // Patch form.
  const warnings: MergeWarning[] = []
  const patch = child as { add?: readonly T[]; remove?: readonly T[] }
  const removeSet = new Set(patch.remove ?? [])

  // Track which `remove` entries actually matched something inherited.
  const matched = new Set<T>()
  const filtered = inherited.filter((item) => {
    const should = !removeSet.has(item)
    if (!should) matched.add(item)
    return should
  })

  for (const r of removeSet) {
    if (!matched.has(r)) {
      warnings.push({
        code: "role_merge_remove_missed",
        message: `${field}: remove entry not found in inherited list`,
        field,
        missing: String(r),
      })
    }
  }

  // Append additions (dedupe against the already-filtered accumulator).
  const out = [...filtered]
  for (const a of patch.add ?? []) {
    if (!out.includes(a)) out.push(a)
  }

  return { value: out, warnings }
}

/**
 * Deep-merge two plain objects (used for `metadata`). Arrays at any
 * depth are replaced by the child's array (NOT concatenated) — same
 * semantics as Helm strategic merge for non-list-strategy maps.
 */
function deepMerge(parent: unknown, child: unknown): unknown {
  if (child === undefined) return parent
  if (typeof parent !== "object" || parent === null || Array.isArray(parent)) {
    return child
  }
  if (typeof child !== "object" || child === null || Array.isArray(child)) {
    return child
  }
  const out: Record<string, unknown> = { ...(parent as Record<string, unknown>) }
  for (const [k, v] of Object.entries(child as Record<string, unknown>)) {
    out[k] = deepMerge((parent as Record<string, unknown>)[k], v)
  }
  return out
}

/**
 * Strategic-merge a parent role (already resolved, plain handle) with
 * a child role's raw input. Returns a fully-typed `RoleHandle` and any
 * merge-time warnings.
 *
 * The merger does NOT validate against the canonical schema — that is
 * the caller's responsibility (typically `resolveRole` validates the
 * final merged role at the end of chain walking).
 *
 * Override fields (scalars + non-list maps + single bindings) follow
 * `child wins if defined`. Local-only fields are NEVER inherited from
 * the parent: the resolved role carries the local-only fields of the
 * leaf (current) child, never of any ancestor.
 */
export function mergeRoles(parent: RoleHandle, child: RoleChildInput): MergeResult {
  const warnings: MergeWarning[] = []

  // Helper: apply a child override (scalar / single ref) using
  // `child wins if defined` semantics.
  const pick = <K extends keyof RoleDefinition>(key: K): RoleDefinition[K] => {
    const c = (child as Partial<RoleDefinition>)[key]
    return c !== undefined ? c : parent[key]
  }

  // List-strategy fields — patch or replace per spec.
  const lists: { [K in ListField]: string[] } = {} as never
  for (const field of LIST_FIELDS) {
    const inherited =
      field === "responsibilities"
        ? (parent.responsibilities as readonly string[])
        : (parent[field] as readonly string[] | undefined) ?? []
    const childField = (child as RoleChildInput)[field] as
      | ListPatch<string>
      | undefined
    const result = applyListPatch(field, inherited, childField)
    warnings.push(...result.warnings)
    lists[field] = result.value
  }

  // `responsibilities` is `[string, ...string[]]` in the canonical
  // schema. The merger preserves the constraint by typing the output.
  if (lists.responsibilities.length === 0) {
    // Should never happen — parent.responsibilities is required ≥ 1,
    // and append-and-dedupe never empties it. A plain-array override
    // with an empty list would; we defensively keep the parent's.
    lists.responsibilities = [...parent.responsibilities]
  }

  const merged: RoleDefinition = {
    // Doctype identity — child wins if set.
    schema: "role/v1",
    name: pick("name") as string,
    title: pick("title") as string,
    description: pick("description") as string,
    version: pick("version") as string,
    seniority: pick("seniority") as RoleDefinition["seniority"],
    mission: pick("mission") as string,

    // Org placement — overrides.
    department: pick("department") as string | undefined,
    reports_to: pick("reports_to") as string | undefined,

    // Lifecycle hooks — overrides.
    onPromotion: pick("onPromotion") as string | undefined,
    onDemotion: pick("onDemotion") as string | undefined,
    onAssign: pick("onAssign") as string | undefined,

    // Single bindings — overrides.
    defaultPersona: pick("defaultPersona") as string | undefined,
    defaultIdentity: pick("defaultIdentity") as string | undefined,
    defaultPolicy: pick("defaultPolicy") as string | undefined,

    // Local-only fields — child's value carries; parent's is dropped.
    extends: child.extends,
    appliesTo: child.appliesTo as string[] | undefined,

    // List-strategy.
    responsibilities: lists.responsibilities as [string, ...string[]],
    capabilities: lists.capabilities,
    tools: lists.tools,
    skills: lists.skills,
    kpis: lists.kpis,
    strengths: lists.strengths,
    antiPatterns: lists.antiPatterns,
    tags: lists.tags,

    // Deep-merged maps.
    metadata: deepMerge(parent.metadata ?? {}, child.metadata) as Record<
      string,
      unknown
    >,
  }

  // Strip the local-only fields if the child didn't set them — we
  // never want them to leak from the parent into the merged role.
  if (child.extends === undefined) delete (merged as Partial<RoleDefinition>).extends
  if (child.appliesTo === undefined)
    delete (merged as Partial<RoleDefinition>).appliesTo

  return { role: merged as RoleHandle, warnings }
}

/**
 * Body merge for ROLE.md body markdown. The parent's body comes from
 * the resolved parent manifest; the child's body comes from the
 * current frontmatter parse. The default is `append-with-separator`;
 * `metadata['aip-47'].bodyMerge === 'replace'` switches to replace.
 */
export function mergeBodies(
  parentBody: string | undefined,
  childBody: string | undefined,
  mode: "append-with-separator" | "replace" = "append-with-separator",
): string {
  if (!parentBody) return childBody ?? ""
  if (!childBody) return parentBody
  if (mode === "replace") return childBody
  return `${parentBody.trimEnd()}\n\n---\n\n${childBody.trimStart()}`
}
