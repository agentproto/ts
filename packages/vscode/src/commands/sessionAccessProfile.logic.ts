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
import { resolveEffectiveRoute } from "@agentproto/runtime/catalog-models"

import type { AccessRow } from "./sessionConfig.logic.js"
import { currentRouteOf, resolveAccessRows } from "./sessionConfig.logic.js"
import { parseRestartResult, type RestartResult } from "./sessionRestart.logic.js"

/**
 * The access rows to offer for a session: every known profile (each flagged
 * with whether it is eligible on the session's route) plus the
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
 * The daemon call a chosen profile turns into: the restart-with-override
 * route (`POST /sessions/:id/restart`) with the profile as the ACCESS
 * override. The daemon keeps the session's POSTURE (an omitted axis is
 * carried forward from the prior session) and re-arms the cron jobs that
 * targeted the old session id.
 */
export interface AccessProfileApplier {
  restartSessionWithOverride(
    id: string,
    overrides: { access: { profileRef: string }; model?: string },
  ): Promise<unknown>
}

/**
 * Apply a chosen profile: restart the session onto it.
 *
 * Returns the RESTARTED session (a restart always mints a fresh id, the
 * conversation is resumed, the row is not reused) or the daemon's refusal
 * on failure. Never throws: a rejected profile (not eligible on this
 * session's route) is a real answer the UI has to show, not a crash.
 */
export async function applyAccessProfile(input: {
  applier: AccessProfileApplier
  sessionId: string
  profileRef: string
  model?: string
}): Promise<{ ok: true; restart?: RestartResult } | { ok: false; error: string }> {
  try {
    const raw = await input.applier.restartSessionWithOverride(input.sessionId, {
      ...(input.model ? { model: input.model } : {}),
      access: { profileRef: input.profileRef },
    })
    const restart = parseRestartResult(raw)
    return { ok: true, ...(restart ? { restart } : {}) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Models the selected wallet can bill, narrowed to free ids when the old
 * session has a zero-cost guard. The daemon remains the final policy judge. */
export function modelsForAccessProfile(
  catalog: CatalogModelsResponse | undefined,
  profileRef: string,
  zeroCostOnly: boolean,
): string[] {
  if (!catalog) return []
  const refs = catalog.vendors.flatMap(v => v.products.flatMap(p => p.routes))
    .filter(r => r.runnable && r.eligibleProfiles.includes(profileRef))
    .map(r => r.ref)
    .filter(ref => !zeroCostOnly || ref.endsWith("-free") || ref.endsWith("/big-pickle"))
  return [...new Set(refs)].sort()
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

/**
 * Make a model switch atomic with its wallet. `model` and `access` are
 * independent axes, but the daemon validates the pair on restart: moving to a
 * model on another route (e.g. `opencode/x` → `opencode-go/x`) with the old
 * profile carried forward is a 400 ("not eligible … on route …"). So when a
 * restart override changes the model, resolve the TARGET route's eligible
 * profiles and, if the attached one isn't among them, ship the first eligible
 * profile in the SAME request. The daemon's eligibility rule is untouched.
 *
 *  - override has no `model`, or already carries `access` → unchanged;
 *  - attached profile still eligible on the target route → unchanged;
 *  - another eligible profile exists → `access` auto-picked (first listed);
 *  - none eligible (or the catalog knows no route) → unchanged for the unknown
 *    case (the daemon stays the judge), `error` for a known route with no profile.
 */
export function withEligibleAccess<O extends { model?: string; access?: { profileRef: string } }>(
  override: O,
  session: Pick<SessionDescriptor, "route" | "accessProfile" | "model">,
  catalog: CatalogModelsResponse | undefined,
): { override: O; autoPickedProfile?: string; error?: string } {
  const model = override.model
  if (!model || override.access) return { override }
  const attached = session.accessProfile?.profileRef
  if (!attached) return { override }

  // A model that pins its own route (`opencode-go/…`, `…@route`) must not
  // inherit the OLD session's gateway when resolving the target route.
  const gateway = resolveEffectiveRoute(model, undefined) ? undefined : session.route?.gateway
  const target = currentRouteOf(
    { model, ...(gateway ? { route: { gateway } } : {}) } as Pick<SessionDescriptor, "route" | "model">,
    catalog,
  )
  if (!target) return { override }
  const eligible = target.eligibleProfiles ?? []
  if (eligible.includes(attached)) return { override }
  const first = eligible[0]
  if (!first) {
    return {
      override,
      error: `no auth profile is eligible for "${model}" on route "${target.value}" — add one first`,
    }
  }
  return { override: { ...override, access: { profileRef: first } }, autoPickedProfile: first }
}
