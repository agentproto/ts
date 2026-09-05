/**
 * Shared static `$steps.<id>` reference grammar check (AIP-16): rejects a
 * `$steps.<id>` reference to a step id that doesn't exist anywhere in the
 * workflow — the same typo class an unresolved reference would otherwise
 * silently pass through as `undefined` at runtime. Used by both the
 * workflow-loader (load-time `with:` blocks) and the workflow-runtime
 * (compile-time step `inputs`).
 */

/** Options a caller must supply: how to build the thrown error (so each
 *  package keeps its own error class) and whether nested array/object
 *  traversal should extend the label with the path segment
 *  (`label[0].key`) or keep the caller-provided label verbatim. */
export interface KnownStepRefsOptions {
  makeError: (message: string) => Error
  extendLabel?: boolean
}

/** Statically reject a `$steps.<id>` reference to a step id that doesn't
 *  exist anywhere in this workflow. Walks strings, arrays, and plain
 *  objects; skips `$$`-escaped strings. Throws via `opts.makeError`. */
export function assertKnownStepRefs(
  node: unknown,
  knownStepIds: ReadonlySet<string>,
  label: string,
  opts: KnownStepRefsOptions,
): void {
  if (typeof node === "string") {
    if (node.startsWith("$$")) return
    const m = node.match(/^\$steps\.([^.]+)/)
    if (m && !knownStepIds.has(m[1]!)) {
      throw opts.makeError(
        `${label} references unknown step '${m[1]}' via '${node}' — no step with that id exists in this workflow`,
      )
    }
    return
  }
  if (Array.isArray(node)) {
    node.forEach((n, i) =>
      assertKnownStepRefs(n, knownStepIds, opts.extendLabel ? `${label}[${i}]` : label, opts),
    )
    return
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>))
      assertKnownStepRefs(v, knownStepIds, opts.extendLabel ? `${label}.${k}` : label, opts)
  }
}
