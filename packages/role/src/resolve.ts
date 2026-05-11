/**
 * AIP-47 role resolver — walks the `extends` chain, merges, validates.
 *
 * Pipeline:
 *   1. dispatch the ref through the source chain — first match wins
 *   2. if the loaded manifest has `extends`, recurse to resolve the
 *      parent (cycle-detected, depth-capped, warnings on missing)
 *   3. apply strategic merge (parent + child) per AIP-47 §Merge
 *      strategy via `merge.ts`
 *   4. validate the merged frontmatter against the canonical zod
 *      schema (defensive — sources MAY ship raw / patch-form input)
 *   5. return `{ role, body, chain, warnings }`
 *
 * Cycle detection: tracks visited refs during chain walk.
 * Depth limit: max 8 (per spec recommendation).
 * Missing parent: warning, fallback to the local manifest.
 */

import { roleFrontmatterSchema } from "./schema.js"
import { mergeBodies, mergeRoles, type MergeWarning } from "./merge.js"
import type { RoleDefinition, RoleHandle } from "./types.js"
import type { RoleManifestRaw, RoleRef, RoleSource } from "./sources/types.js"

const DEFAULT_MAX_DEPTH = 8

export type ResolveWarning =
  | MergeWarning
  | {
      code: "role_unresolvable"
      message: string
      ref: string
    }
  | {
      code: "role_extends_cycle"
      message: string
      cycle: readonly string[]
    }
  | {
      code: "role_extends_depth_exceeded"
      message: string
      depth: number
      ref: string
    }
  | {
      code: "role_extends_missing"
      message: string
      parent: string
    }
  | {
      code: "role_validation_failed"
      message: string
      ref: string
      issues: readonly string[]
    }

export interface ResolveOptions {
  /** Source chain — consulted in order, first match wins. */
  readonly sources: readonly RoleSource[]
  /** Maximum `extends` chain depth. Default 8. */
  readonly maxDepth?: number
}

export interface ResolvedRole {
  /** Effective role after `extends`-chain merge. Always plain lists. */
  readonly role: RoleHandle
  /** Merged body markdown — parent appended with `\n\n---\n\n` separator. */
  readonly body: string
  /**
   * Ordered list of refs walked, from leaf to root.
   * `chain[0]` is the requested ref; the last entry is the root parent.
   */
  readonly chain: readonly string[]
  /** Diagnostics emitted during resolution + merge. */
  readonly warnings: readonly ResolveWarning[]
}

/**
 * Resolve a role ref through the source chain and merge any
 * `extends` lineage. Throws iff the leaf ref cannot be loaded AND no
 * partial result is recoverable (i.e. the top-level lookup fails).
 *
 * Intermediate failures (cycle, depth, missing parent) MUST NOT
 * throw — they emit warnings and the resolver falls back to the
 * local manifest. This is the AIP-47 spec contract:
 *
 *   "Treat depth overflow and cycle detection as warnings, not
 *    errors. A role whose chain is malformed MUST still load — the
 *    runtime falls back to the local manifest only."
 */
export async function resolveRole(
  ref: RoleRef,
  opts: ResolveOptions,
): Promise<ResolvedRole> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH
  const visited = new Set<string>()
  const warnings: ResolveWarning[] = []
  const chain: string[] = []

  const load = async (current: RoleRef): Promise<RoleManifestRaw | null> => {
    for (const src of opts.sources) {
      const m = await src.load(current)
      if (m !== null) return m
    }
    return null
  }

  // Recursive walker. Returns the merged role (or null on hard failure).
  // The leaf is loaded first; the parent chain is walked top-down so
  // we merge child onto parent (parent is the accumulator base).
  //
  // `isParentRef` discriminates leaf-miss (caller throws role_unresolvable)
  // from parent-miss (we warn role_extends_missing and the caller falls
  // back to its local manifest).
  const walk = async (
    current: RoleRef,
    depth: number,
    isParentRef: boolean,
  ): Promise<{ role: RoleHandle; body: string } | null> => {
    if (depth > maxDepth) {
      warnings.push({
        code: "role_extends_depth_exceeded",
        message: `extends chain depth exceeded ${maxDepth} at '${current}'`,
        depth,
        ref: current,
      })
      return null
    }
    if (visited.has(current)) {
      warnings.push({
        code: "role_extends_cycle",
        message: `extends cycle detected at '${current}'`,
        cycle: [...visited, current],
      })
      return null
    }
    visited.add(current)

    const manifest = await load(current)
    if (!manifest) {
      // Parent-miss is a warning (caller falls back); leaf-miss is
      // surfaced by the top-level caller as role_unresolvable.
      if (isParentRef) {
        warnings.push({
          code: "role_extends_missing",
          message: `parent ref '${current}' did not resolve`,
          parent: current,
        })
      }
      return null
    }
    chain.push(manifest.ref)

    const fm = manifest.frontmatter as Partial<RoleDefinition>
    const extendsRef = fm.extends

    if (!extendsRef) {
      return { role: fm as RoleHandle, body: manifest.body }
    }

    const parent = await walk(extendsRef, depth + 1, true)
    if (!parent) {
      // Parent chain broken — fall back to the local manifest only.
      // The warning was already pushed by the recursive call.
      return { role: fm as RoleHandle, body: manifest.body }
    }

    // Apply strategic merge.
    const merged = mergeRoles(parent.role, fm)
    warnings.push(...merged.warnings)

    // Body merge — read bodyMerge mode from child metadata.
    const bodyMode =
      ((fm.metadata as Record<string, unknown> | undefined)?.["aip-47"] as
        | { bodyMerge?: "append-with-separator" | "replace" }
        | undefined)?.bodyMerge ?? "append-with-separator"
    const body = mergeBodies(parent.body, manifest.body, bodyMode)

    return { role: merged.role, body }
  }

  const result = await walk(ref, 0, false)
  if (!result) {
    // Leaf miss (or hard chain failure with no fallback). Per AIP-47,
    // the resolver MUST surface `role_unresolvable` and throw — the
    // caller cannot proceed without a role.
    const w: ResolveWarning = {
      code: "role_unresolvable",
      message: `role ref '${ref}' did not resolve in any source`,
      ref,
    }
    warnings.push(w)
    throw Object.assign(new Error(w.message), { warnings, chain })
  }

  // Defensive validation of the merged frontmatter.
  const validated = roleFrontmatterSchema.safeParse(result.role)
  if (!validated.success) {
    const issues = validated.error.issues.map(
      (i) => `${i.path.join(".")}: ${i.message}`,
    )
    warnings.push({
      code: "role_validation_failed",
      message: `merged role failed schema validation`,
      ref,
      issues,
    })
    // Still return the merged role — validators downstream may want
    // to surface it. The warning makes the failure observable.
  }

  return {
    role: validated.success ? (validated.data as RoleHandle) : result.role,
    body: result.body,
    chain,
    warnings,
  }
}
