/**
 * Workflow execution profiles for the staged decision workflow
 * (`decision-route`). A profile is deliberately NOT a second policy engine and
 * NOT part of DECISION.md: the policy owns criteria / choices / uncertainty
 * rules; the profile owns which models and harnesses the workflow may spawn,
 * which auth profile they bill, and the attempt/deadline budget.
 *
 * It reuses the daemon's existing config — harness presets, user presets, the
 * `models` role table, the OpenRouter billing guard — and adds exactly one
 * thing: an entitlement ceiling checked BEFORE any spawn.
 *
 *   free-only      OpenCode ids ending in `-free` (or `big-pickle`) through the
 *                  OpenCode adapter. Nothing else — a paid preset, an Opus/
 *                  Sonnet fallback, a rotate target or a recovery override that
 *                  resolves to a non-free id is refused, never substituted.
 *   subscription   free ids, plus Claude Code Sonnet.
 *
 * Sandbox placement (e2b, …) is not an input here and grants nothing: where a
 * session runs says nothing about what it is allowed to bill.
 *
 * Identity must be provable. A target with no adapter, no model, a dynamic
 * `@route` suffix or an unreadable auth profile is refused (fail closed).
 */

import { isOpencodeFreeModel } from "./turn-retry-policy.js"
import { adapterForModelId, type ResolvedModelRole } from "./model-roles.js"
import {
  reviewerFingerprint,
  reviewerModel,
  reviewerOpenRouterViolation,
  reviewerProfileRef,
  resolveReviewerPreset,
  type DaemonReviewerHostDeps,
} from "./review-reviewer-host.js"
import { getDefaultHarnessPreset } from "./harness-preset-store.js"
import type { UserPreset } from "./user-presets.js"
import type { SpawnAgentSessionInput } from "./session-spawn.js"
import type { AuthProfile } from "@agentproto/auth"

export type DecisionEntitlement = "free-only" | "subscription"

export interface DecisionEscalationTarget {
  /** A harness/user preset id (resolved through the existing preset stores). */
  readonly preset?: string
  /** Or an explicit adapter + model (+ auth profile). */
  readonly adapter?: string
  readonly model?: string
  readonly profileRef?: string
  /** Subscription profiles only: take the model from the `review.small` role. */
  readonly roleDefault?: boolean
}

export interface DecisionExecProfile {
  readonly id: string
  readonly entitlement: DecisionEntitlement
  /** Jev direct API classification. Off by default for the free profile. */
  readonly jev: { readonly enabled: boolean; readonly timeoutMs: number }
  /** The ONE escalation allowed per run, through the configured harness. */
  readonly escalation: DecisionEscalationTarget & { readonly timeoutMs: number }
  /** Upper bound for the review step (poll + cancel). */
  readonly review: { readonly timeoutMs: number }
}

export const DECISION_PROFILE_IDS = ["local-free", "remote-sonnet"] as const
export type DecisionProfileId = (typeof DECISION_PROFILE_IDS)[number]

const BUILTIN: Readonly<Record<DecisionProfileId, DecisionExecProfile>> = {
  "local-free": {
    id: "local-free",
    entitlement: "free-only",
    jev: { enabled: false, timeoutMs: 20_000 },
    escalation: { timeoutMs: 120_000 },
    review: { timeoutMs: 20 * 60_000 },
  },
  "remote-sonnet": {
    id: "remote-sonnet",
    entitlement: "subscription",
    jev: { enabled: true, timeoutMs: 20_000 },
    escalation: { roleDefault: true, timeoutMs: 120_000 },
    review: { timeoutMs: 30 * 60_000 },
  },
}

/** `GATE_EXEC_PROFILE` spellings (studio review client) → built-in profile. */
const PROFILE_ALIASES: Readonly<Record<string, DecisionProfileId>> = {
  "free-only": "local-free",
  subscription: "remote-sonnet",
}

/** Operator-supplied narrowing of a built-in profile (workflow input). It can
 *  pick models and tighten budgets; it can NEVER change the entitlement. */
export interface DecisionProfileInput {
  readonly profile?: string
  readonly jev?: boolean
  readonly escalation?: DecisionEscalationTarget & { readonly timeoutMs?: number }
  readonly reviewTimeoutMs?: number
}

const MAX_ESCALATION_MS = 10 * 60_000
const MAX_REVIEW_MS = 60 * 60_000

const clampMs = (v: unknown, fallback: number, max: number): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), max) : fallback

export function resolveExecProfile(
  input: DecisionProfileInput = {},
): { ok: true; profile: DecisionExecProfile } | { ok: false; error: string } {
  const requested = input.profile ?? "local-free"
  const id = PROFILE_ALIASES[requested] ?? requested
  const base = (BUILTIN as Readonly<Record<string, DecisionExecProfile | undefined>>)[id]
  if (!base) {
    return { ok: false, error: `unknown profile "${requested}" — expected one of: ${DECISION_PROFILE_IDS.join(", ")}` }
  }
  const e = input.escalation
  const target: DecisionEscalationTarget = e
    ? {
        ...(e.preset !== undefined ? { preset: e.preset } : {}),
        ...(e.adapter !== undefined ? { adapter: e.adapter } : {}),
        ...(e.model !== undefined ? { model: e.model } : {}),
        ...(e.profileRef !== undefined ? { profileRef: e.profileRef } : {}),
        ...(e.roleDefault !== undefined ? { roleDefault: e.roleDefault } : {}),
      }
    : base.escalation
  const hasTarget = target.preset !== undefined || target.model !== undefined || target.roleDefault === true
  return {
    ok: true,
    profile: {
      id: base.id,
      entitlement: base.entitlement,
      jev: {
        enabled: input.jev ?? base.jev.enabled,
        timeoutMs: base.jev.timeoutMs,
      },
      escalation: {
        ...(hasTarget ? target : {}),
        timeoutMs: clampMs(e?.timeoutMs, base.escalation.timeoutMs, MAX_ESCALATION_MS),
      },
      review: { timeoutMs: clampMs(input.reviewTimeoutMs, base.review.timeoutMs, MAX_REVIEW_MS) },
    },
  }
}

// ── spawn-target validation (pure) ────────────────────────────────────────

export interface SpawnTarget {
  readonly adapter?: string | undefined
  readonly model?: string | undefined
  readonly profileRef?: string | undefined
  /** An explicit gateway route on the preset — never allowed under free-only. */
  readonly route?: unknown
  /** Models a `turnRetry.rotate` list could move the session onto. */
  readonly rotate?: ReadonlyArray<{ readonly model: string; readonly profileRef?: string }> | undefined
  /** Accepted and ignored on purpose: placement grants no entitlement. */
  readonly sandbox?: unknown
}

export type TargetVerdict =
  | { readonly ok: true; readonly adapter: string; readonly model: string }
  | { readonly ok: false; readonly code: string; readonly reason: string }

const SONNET_RE = /^claude-sonnet[-\w.]*$/i

function modelAllowed(
  entitlement: DecisionEntitlement,
  adapter: string,
  model: string,
): string | undefined {
  if (model.includes("@")) {
    return `model "${model}" carries a dynamic @route suffix — the billing endpoint is not provable`
  }
  if (/openrouter/i.test(model)) return `model "${model}" would bill OpenRouter`
  if (adapter === "opencode") {
    if (isOpencodeFreeModel(model)) return undefined
    return `model "${model}" is not an OpenCode free id (-free / big-pickle)`
  }
  if (entitlement === "subscription" && adapter === "claude-code") {
    return SONNET_RE.test(model) ? undefined : `model "${model}" is not Claude Code Sonnet`
  }
  return entitlement === "free-only"
    ? `adapter "${adapter}" is not permitted under a free-only profile (OpenCode free ids only)`
    : `adapter "${adapter}" with model "${model}" is not permitted (OpenCode free ids or Claude Code Sonnet only)`
}

/** Fail-closed check of one concrete spawn target against the profile's
 *  entitlement, including every rotate fallback. */
export function validateSpawnTarget(profile: DecisionExecProfile, target: SpawnTarget): TargetVerdict {
  const adapter = target.adapter?.trim()
  const model = target.model?.trim()
  if (!adapter) return { ok: false, code: "unknown_adapter", reason: "no adapter resolved — identity is not provable" }
  if (!model) {
    return {
      ok: false,
      code: "unknown_model",
      reason: `no explicit model on adapter "${adapter}" — a harness default is dynamic identity, refused`,
    }
  }
  if (target.route !== undefined && profile.entitlement === "free-only") {
    return { ok: false, code: "route_not_free", reason: "an explicit gateway route is not allowed under a free-only profile" }
  }
  const bad = modelAllowed(profile.entitlement, adapter, model)
  if (bad) return { ok: false, code: "not_entitled", reason: `${bad} (profile ${profile.id}: ${profile.entitlement})` }
  for (const r of target.rotate ?? []) {
    const rotateAdapter = adapterForModelId(r.model) ?? (isOpencodeFreeModel(r.model) ? "opencode" : undefined)
    if (!rotateAdapter) {
      return { ok: false, code: "unknown_rotate", reason: `turnRetry.rotate target "${r.model}" has no provable adapter` }
    }
    const rotateBad = modelAllowed(profile.entitlement, rotateAdapter, r.model)
    if (rotateBad) {
      return { ok: false, code: "rotate_not_entitled", reason: `turnRetry.rotate: ${rotateBad} (profile ${profile.id})` }
    }
  }
  return { ok: true, adapter, model }
}

// ── preset resolution (async; reuses the existing stores + OpenRouter guard) ──

export interface PresetLookups extends Pick<DaemonReviewerHostDeps, "getHarnessPreset" | "getUserPreset" | "getAuthProfile"> {
  /** Default-harness-preset lookup (what a bare spawn would inherit). */
  readonly getDefaultHarnessPreset?: (harness: string) => Promise<{ profileRef: string; defaultModel?: string } | undefined>
  /** The configured `review.small` role (workspace/daemon `models` block). */
  readonly resolveRole?: (role: string) => ResolvedModelRole | undefined
}

export type ResolvedTarget =
  | {
      readonly ok: true
      readonly adapter: string
      readonly model: string
      readonly profileRef?: string
      readonly fingerprint: string
      /** Spawn fields — explicit, so no later layer can substitute. */
      readonly spawn: Pick<SpawnAgentSessionInput, "adapter" | "model"> & Partial<Pick<SpawnAgentSessionInput, "access">>
    }
  | { readonly ok: false; readonly code: string; readonly reason: string }

type FieldBag = Pick<SpawnAgentSessionInput, "adapter" | "model" | "access" | "preset">

/** Resolve a preset id / explicit target to concrete spawn fields and run the
 *  entitlement + OpenRouter checks on what would ACTUALLY run — including the
 *  auth profile a bare spawn would inherit from the harness default preset. */
export async function resolveAndValidateTarget(
  profile: DecisionExecProfile,
  target: DecisionEscalationTarget & { readonly model?: string },
  lookups: PresetLookups = {},
  override?: { readonly model?: string; readonly profile?: string },
): Promise<ResolvedTarget> {
  let fields: FieldBag | undefined
  let label = target.preset ?? target.model ?? "(unset)"
  if (target.preset) {
    fields = await resolveReviewerPreset(target.preset, lookups)
    if (!fields) {
      return { ok: false, code: "preset_not_found", reason: `preset "${target.preset}" is not a harness or user preset` }
    }
  } else if (target.roleDefault && !target.adapter && !target.model) {
    const role = lookups.resolveRole?.("review.small")
    if (!role) return { ok: false, code: "no_target", reason: "roleDefault set but the review.small role is not resolvable" }
    if (role.route) {
      return { ok: false, code: "route_not_free", reason: `role review.small routes through "${role.route}" — a gateway route is not provable` }
    }
    if (!role.adapter) {
      return { ok: false, code: "unknown_adapter", reason: `role review.small model "${role.model}" implies no adapter` }
    }
    fields = {
      adapter: role.adapter,
      model: role.model,
      ...(role.profile ? { access: { profileRef: role.profile } } : {}),
    }
    label = `role:review.small(${role.model})`
  } else if (target.adapter || target.model) {
    const adapter = target.adapter ?? (target.model ? adapterForModelId(target.model) : undefined)
    if (!adapter) {
      return { ok: false, code: "unknown_adapter", reason: `no adapter for model "${target.model ?? ""}" — name one explicitly` }
    }
    fields = {
      adapter,
      ...(target.model ? { model: target.model } : {}),
      ...(target.profileRef ? { access: { profileRef: target.profileRef } } : {}),
    }
    label = `${adapter}:${target.model ?? "?"}`
  } else {
    return { ok: false, code: "no_target", reason: "no escalation preset or model configured — nothing is substituted" }
  }

  if (override?.model) {
    fields = {
      ...fields,
      model: override.model,
      ...(override.profile ? { access: { profileRef: override.profile } } : {}),
    }
  }

  const user = fields.preset as (UserPreset & Record<string, unknown>) | undefined
  const adapter = fields.adapter ?? user?.adapter ?? user?.harness
  const model = reviewerModel(fields)
  const verdict = validateSpawnTarget(profile, {
    adapter,
    model,
    profileRef: reviewerProfileRef(fields),
    route: user?.route,
    rotate: user?.turnRetry?.rotate,
  })
  if (!verdict.ok) return verdict

  // Auth profile a bare spawn would inherit when none is named: the harness
  // default preset's. Check THAT one against the OpenRouter guard too.
  let profileRef = reviewerProfileRef(fields)
  if (!profileRef) {
    try {
      const inherited = await (lookups.getDefaultHarnessPreset ?? getDefaultHarnessPreset)(verdict.adapter)
      profileRef = inherited?.profileRef
    } catch {
      return { ok: false, code: "profile_unreadable", reason: `could not read the default harness preset for "${verdict.adapter}"` }
    }
  }
  const guarded: FieldBag = {
    ...fields,
    ...(profileRef ? { access: { profileRef } } : {}),
  }
  const violation = await reviewerOpenRouterViolation(target.preset ?? label, guarded, lookups.getAuthProfile as
    | ((id: string) => Promise<AuthProfile | undefined>)
    | undefined)
  if (violation) return { ok: false, code: "openrouter", reason: violation }

  return {
    ok: true,
    adapter: verdict.adapter,
    model: verdict.model,
    ...(profileRef ? { profileRef } : {}),
    fingerprint: reviewerFingerprint(guarded),
    spawn: {
      adapter: verdict.adapter,
      model: verdict.model,
      ...(profileRef ? { access: { profileRef } } : {}),
    },
  }
}
