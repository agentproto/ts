/**
 * Pure logic for the "set session access profile" flow — attaching a named auth
 * profile to an existing session by restarting it with an `access` override.
 * Per SPEC §4.3 the access axis is restart-only (you cannot rebind a live
 * wallet), so this is the config strip's `access` chip made actionable as a
 * standalone command. No `vscode` import → unit-testable under plain vitest.
 *
 * Reuses the sessionConfig resolver (`currentRouteOf` + `resolveAccessRows`) so
 * the offered profiles are exactly the route-eligible ones the config strip
 * would show — the two surfaces never drift.
 */

import type {
  AuthProfileSummary,
  CatalogModelsResponse,
  SessionDescriptor,
} from "../client/types.js"
import type { AccessRow } from "./sessionConfig.logic.js"
import { currentRouteOf, resolveAccessRows } from "./sessionConfig.logic.js"

/**
 * The access rows to offer for a session: its route-eligible profiles plus the
 * trailing "+ add profile" row, whether the currently-attached profile has
 * become ineligible (→ the caller nudges a re-pick), and the current profileRef
 * (so the flow can no-op a re-pick of the same wallet). Thin adapter over the
 * sessionConfig resolver.
 */
export function accessRowsForSession(input: {
  descriptor: Pick<SessionDescriptor, "route" | "model" | "accessProfile">
  catalog?: CatalogModelsResponse
  profiles?: readonly AuthProfileSummary[]
}): { rows: AccessRow[]; ineligibleAttached?: string; currentProfileRef?: string } {
  const currentRoute = currentRouteOf(input.descriptor, input.catalog)
  const { rows, ineligibleAttached } = resolveAccessRows({
    currentRoute,
    profiles: input.profiles,
    attachedProfileRef: input.descriptor.accessProfile?.profileRef,
  })
  const currentProfileRef = input.descriptor.accessProfile?.profileRef
  return {
    rows,
    ...(ineligibleAttached ? { ineligibleAttached } : {}),
    ...(currentProfileRef ? { currentProfileRef } : {}),
  }
}

/**
 * What picking an access row means:
 *  - `noop`       — the same profile is already attached (or an empty pick);
 *  - `addProfile` — the "+ add profile" row → open the create/login flow;
 *  - `attach`     — restart the session onto `profileRef`. `killFirst` is set
 *    when the session is live: `session_restart` has no status guard and would
 *    otherwise leave the old session running as a duplicate
 *    (session-restart-core.ts never retires `prev`), so a live attach must kill
 *    the session first, then restart-resume it onto the new wallet.
 */
export type AccessPlan =
  | { kind: "noop" }
  | { kind: "addProfile" }
  | { kind: "attach"; profileRef: string; killFirst: boolean }

export function planAccessChange(input: {
  picked: Pick<AccessRow, "value" | "addProfile">
  currentProfileRef?: string
  isLive: boolean
}): AccessPlan {
  if (input.picked.addProfile) return { kind: "addProfile" }
  const profileRef = input.picked.value
  if (!profileRef) return { kind: "noop" }
  if (profileRef === input.currentProfileRef) return { kind: "noop" }
  return { kind: "attach", profileRef, killFirst: input.isLive }
}
