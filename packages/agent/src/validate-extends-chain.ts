/**
 * AIP-42: extends-chain integrity validation.
 *
 * Spec constraints (AIP-42 §extends):
 *   - Depth ≤ 5 levels (5 extends hops from root)
 *   - No cycles (same `id` must not appear twice in the chain)
 *
 * Inline `extends` blocks carry no stable external `id` and cannot
 * form registry-level cycles; the chain walk stops at the first one.
 *
 * This is intentionally a standalone async function rather than a
 * hook inside `defineAgent` — chain validation requires loading parent
 * manifests from disk or a registry, which is inherently async and
 * unavailable in the synchronous `defineAgent` path.
 *
 * Usage with `agentVerbs`:
 *
 *   await validateExtendsChain(handle, {
 *     async loadParent(ref) {
 *       if (typeof ref !== 'string') return null
 *       try {
 *         const { handle } = await agentVerbs.load(`.agents/${ref}/AGENT.md`)
 *         return { id: handle.id, extends: handle.extends }
 *       } catch { return null }
 *     },
 *   })
 */

export const EXTENDS_MAX_DEPTH = 5

/**
 * An `extends` reference from the AGENT.md frontmatter.
 * Mirrors `AgentDefinition['extends']`.
 */
export type ExtendsRef =
  | string
  | { ref?: string; file?: string; inline?: Record<string, unknown> }

/**
 * Load a parent agent's identity and `extends` field by ref.
 * Return `null` when the ref cannot be resolved (treated as chain end,
 * not an error — unresolvable refs are caught at runtime, not here).
 */
export interface ExtendsChainLoader {
  loadParent(
    ref: ExtendsRef,
  ): Promise<{ id: string; extends?: ExtendsRef | null | undefined } | null>
}

/**
 * Validate an agent's `extends` chain for depth and cycle constraints.
 *
 * Throws with a `"defineAgent (AIP-42): …"` message on violation so
 * the error is consistent with the synchronous `defineAgent` errors.
 */
export async function validateExtendsChain(
  root: { id: string; extends?: ExtendsRef | null | undefined },
  loader: ExtendsChainLoader,
): Promise<void> {
  const visited = new Set<string>([root.id])
  let current: { id: string; extends?: ExtendsRef | null | undefined } = root
  let depth = 0

  while (current.extends != null) {
    const ref = current.extends

    // Inline blocks have no stable external id — stop traversal here.
    if (typeof ref === "object" && "inline" in ref) break

    depth++
    if (depth > EXTENDS_MAX_DEPTH) {
      throw new Error(
        `defineAgent (AIP-42): extends chain exceeds maximum depth of ` +
          `${EXTENDS_MAX_DEPTH} (chain starting from '${root.id}')`,
      )
    }

    const parent = await loader.loadParent(ref)
    if (parent === null) break

    if (visited.has(parent.id)) {
      throw new Error(
        `defineAgent (AIP-42): circular extends chain — '${parent.id}' ` +
          `appears more than once in the chain starting from '${root.id}'`,
      )
    }

    visited.add(parent.id)
    current = parent
  }
}
