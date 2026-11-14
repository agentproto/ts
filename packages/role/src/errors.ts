/**
 * AIP-47 typed failures.
 */

import type { ResolveWarning } from "./resolve.js"

/**
 * Thrown by `resolveRole` when the requested ref is answered by no source.
 * Carries the `role_unresolvable` code so a caller can branch without
 * matching message text.
 */
export class RoleUnresolvableError extends Error {
  readonly code = "role_unresolvable" as const

  constructor(
    readonly ref: string,
    readonly warnings: readonly ResolveWarning[] = [],
    readonly chain: readonly string[] = [],
  ) {
    super(`role ref '${ref}' did not resolve in any source`)
    this.name = "RoleUnresolvableError"
  }
}
