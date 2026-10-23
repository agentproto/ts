/**
 * @agentproto/usage-presets — usage-named spawn presets.
 *
 * The caller names WHAT the work is (an usage slug: pr-fix, explore,
 * implement, deploy, review) — never WHICH model or WHERE the agent runs.
 * Each usage declares a complete `agent_start` configuration plus ordered,
 * place-aware candidates; `resolveUsagePlan` turns one into a ready spawn
 * plan and enforces the two hard house rules:
 *
 *   1. NO free models for sensitive work. A usage marked `sensitive`
 *      (deploy, production, secrets, payment) only ever resolves to a
 *      paid candidate; a sensitive usage whose candidate list contains a
 *      free model refuses outright with `SensitivityRefusalError`.
 *   2. At most MAX_LOCAL_FREE_AGENTS (2) free agents run as LOCAL
 *      subprocesses against the local IP — past the limit the resolver
 *      redirects the same free model into the sandbox and says why.
 *
 * Place vocabulary: `"local"` (daemon subprocess) or `"sandbox"`
 * (`agent_start.sandbox` — provider `computer`, the OVH box). A usage
 * that does not need the repo's files (pr-fix: the PR is fetched on the
 * box) pins place `"sandbox"` outright.
 */

/** Pure-data types. No zod: these are authored data, validated by tests. */

export type Place = "local" | "sandbox"

export interface SpawnCandidate {
  /** Model ref exactly as `agent_start.model` accepts it. */
  model: string
  /** Named auth profile the spawn bills through. */
  profileRef: string
  /** True when the model is free (no spend, provider rate-limits per IP). */
  free: boolean
  /** The place this candidate is valid in. Omitted = valid at any place. */
  place?: Place
  /** Free models are per-IP rate limited locally — sandbox is the relief. */
  posture: "default" | "plan" | "accept-edits" | "bypass" | "read-only"
}

/**
 * One usage: a slice of work, described the way a brain describes it.
 * `"pr-fix"` — not "opencode · zen · glm · bypass" and not "which of the
 * three profile names is this one".
 */
export interface UsageSpec {
  slug: string
  /** Human label. */
  label: string
  /**
   * Where the agent runs. `"sandbox"` = always the box (the work needs
   * none of the local files); `"local-preferred"` = local is fine, but a
   * FREE local agent yields to the 2-agent IP limit and redirects to
   * sandbox; `"local-paid"` = local, paid model only (sensitive).
   */
  placePolicy:
    | "sandbox"
    | "local-preferred"
    | "local-paid"
  /** True for deploy / production / secrets / payment work. A sensitive
   *  usage refuses any `free: true` candidate, even if one appears in its
   *  candidate list. */
  sensitive?: boolean
  /**
   * Ordered candidates. The resolver selects the first one valid for the
   * place it chose (see `placePolicy`); the overflow redirect selects the
   * first explicitly sandbox-capable free candidate. Later entries are
   * NOT retried automatically on failure.
   */
  candidates: SpawnCandidate[]
  /** Sandbox provider slug for a `"sandbox"` place. */
  sandboxProvider?: string
  /** Worktree policy note, informational. */
  note?: string
}

/** A resolved, ready-to-fire spawn plan. */
export interface UsagePlan {
  usage: string
  resolvedModel: string
  profileRef: string
  adapter: string
  posture: UsageSpec["candidates"][number]["posture"]
  place: Place
  /** Present only when place is `"sandbox"` — the `agent_start.sandbox`
   *  input value. */
  sandbox?: { provider: string }
  /** Index in `candidates` of the candidate actually selected. */
  fallbackUsed: number
  /**
   * Fully serialized `agent_start` input: model, access, posture, place,
   * sandbox. The single point of truth a caller needs to NOT have to
   * remember anything else about models or locations.
   */
  spawn: Record<string, unknown>
  /** Human message when the resolver MOVED the work (limit redirect).
   *  Absent when the default candidate/choice applied cleanly. */
  warning?: string
}

export class UsageError extends Error {}
export class UnknownUsageError extends UsageError {}
export class SensitivityRefusalError extends UsageError {}

/**
 * At most 2 free agents in local — the local IP is rate-limited by the
 * free routes past that. Constraint declared as a constant, asserted by
 * tests.
 */
export const MAX_LOCAL_FREE_AGENTS = 2

/** House rule mapping free ⇒ sandbox relief for the OVERFLOW agent only. */
export function isFreeCandidate(candidate: SpawnCandidate): boolean {
  return candidate.free || candidate.model.endsWith("-free")
}

// ── Candidates (models actually available on this install) ──────────────

export const CANDIDATES = {
  /** Sandbox OVH glm 5.3 flash free — the pr-fix/overflow workhorse. */
  sandboxGlmFree: {
    model: "opencode/glm-5.3-flash-free",
    profileRef: "opencode-api-zen-ws03",
    free: true,
    place: "sandbox",
    posture: "bypass",
  },
  /** Local glm 5.3 flash free (Zen route). */
  localGlmFree: {
    model: "opencode/glm-5.3-flash-free",
    profileRef: "opencode-api-zen-ws03",
    free: true,
    place: "local",
    posture: "bypass",
  },
  /** Local deepseek 4.1 flash free. */
  localDeepseekFree: {
    model: "opencode/deepseek-v4.1-flash-free",
    profileRef: "opencode-api-zen-ws03",
    free: true,
    place: "local",
    posture: "bypass",
  },
  /** Local paid glm 5.3 (OpenCode Go route) — no per-IP limit, spends. */
  localPaidStrong: {
    model: "opencode-go/glm-5.3",
    profileRef: "opencode-developerws003",
    free: false,
    place: "local",
    posture: "bypass",
  },
  /** Sandbox paid glm 5.3 — same as local paid, off the local IP. */
  sandboxPaidStrong: {
    model: "opencode-go/glm-5.3",
    profileRef: "opencode-developerws003",
    free: false,
    place: "sandbox",
    posture: "bypass",
  },
  /** Reviewer: paid deepseek v4 pro, read-only. */
  reviewerPaid: {
    model: "opencode-go/deepseek-v4-pro",
    profileRef: "opencode-developerws003",
    free: false,
    place: "sandbox",
    posture: "read-only",
  },
  /** Reviewer free alternative, read-only, sandbox-safe. */
  reviewerFree: {
    model: "opencode/glm-5.3-flash-free",
    profileRef: "opencode-api-zen-ws03",
    free: true,
    place: "sandbox",
    posture: "read-only",
  },
} as const satisfies Record<string, SpawnCandidate>

// ── The usage registry ──────────────────────────────────────────────────

/**
 * Usages named by WORK, not by model. Each fixes model, place and an
 * ordered list of place-aware candidates.
 */
export const USAGE_PRESETS: Record<string, UsageSpec> = {
  "pr-fix": {
    slug: "pr-fix",
    label: "Correction de PR",
    // A PR fix does not need the local files — run on the box directly.
    placePolicy: "sandbox",
    sandboxProvider: "computer",
    candidates: [
      CANDIDATES.sandboxGlmFree,
      CANDIDATES.sandboxPaidStrong, // same place, paid rail
    ],
    note: "La PR est fetchée dans la sandbox ; les fichiers locaux ne sont pas nécessaires.",
  },
  explore: {
    slug: "explore",
    label: "Exploration",
    placePolicy: "local-preferred",
    candidates: [
      CANDIDATES.localGlmFree,
      CANDIDATES.localDeepseekFree,
      CANDIDATES.sandboxGlmFree, // explicit sandbox candidate for overflow
    ],
  },
  implement: {
    slug: "implement",
    label: "Implémentation",
    placePolicy: "local-preferred",
    candidates: [
      CANDIDATES.localDeepseekFree,
      CANDIDATES.localGlmFree,
      CANDIDATES.sandboxGlmFree, // explicit sandbox candidate for overflow
    ],
  },
  review: {
    slug: "review",
    label: "Revue de code",
    placePolicy: "sandbox",
    sandboxProvider: "computer",
    candidates: [
      CANDIDATES.reviewerPaid,
      CANDIDATES.reviewerFree, // gratuit, toujours read-only
    ],
  },
  deploy: {
    slug: "deploy",
    label: "Déploiement",
    placePolicy: "local-paid",
    sensitive: true,
    candidates: [
      CANDIDATES.localPaidStrong,
      CANDIDATES.sandboxPaidStrong,
      // NO free candidate in this chain: keep it empty of free even at the
      // implementation level (resolveUsagePlan re-refuses free + sensitive
      // as a belt-and-braces check anyway).
    ],
    note: "Usage sensible : jamais de modèle gratuit (déploiement, secrets, paiement, production).",
  },
}

export function listUsageSlugs(): string[] {
  return Object.keys(USAGE_PRESETS)
}

function buildSpawn(
  adapter: string,
  candidate: SpawnCandidate,
  place: Place,
  spec: UsageSpec,
): Record<string, unknown> {
  const spawn: Record<string, unknown> = {
    adapter,
    model: candidate.model,
    access: { profileRef: candidate.profileRef },
    posture: candidate.posture,
    meta: { usage: spec.slug, place },
  }
  if (place === "sandbox") {
    spawn.sandbox = { provider: spec.sandboxProvider ?? "computer" }
  }
  return spawn
}

function candidateForPlace(
  spec: UsageSpec,
  place: Place,
  opts: { freeOnly?: boolean } = {},
): SpawnCandidate {
  return (
    spec.candidates.find(
      c => (c.place ?? place) === place && (!opts.freeOnly || isFreeCandidate(c)),
    ) ?? spec.candidates[0]!
  )
}

// ── The resolver: usage + live free-local count → complete plan ─────────

/**
 * Resolve an usage into a complete `agent_start` input.
 *
 * `freeLocalInUse` is the count of LIVE local sessions already billing a
 * free model (the caller counts them — CLI counts from the daemon's live
 * session list; tests pass explicit counts).
 */
export function resolveUsagePlan(
  slug: string,
  opts: { freeLocalInUse?: number; adapter?: string } = {},
): UsagePlan {
  const spec = USAGE_PRESETS[slug]
  if (!spec) {
    throw new UnknownUsageError(
      `usage inconnu "${slug}" — usages connus : ${listUsageSlugs().join(", ")}`,
    )
  }
  return resolveFromSpec(spec, opts)
}

/**
 * The core resolver over ANY spec — `resolveUsagePlan` looks the committed
 * spec up; this form lets a caller (and the tests) resolve an injected
 * spec directly, including a BYO chain. The sensitivity and capacity
 * guards read the spec, not the registry, so both apply identically.
 */
export function resolveFromSpec(
  spec: UsageSpec,
  opts: { freeLocalInUse?: number; adapter?: string } = {},
): UsagePlan {
  const adapter = opts.adapter ?? "opencode"

  // HARD RULE 1 — sensitive never rides a free model.
  if (spec.sensitive) {
    const freeIndex = spec.candidates.findIndex(isFreeCandidate)
    if (freeIndex !== -1) {
      throw new SensitivityRefusalError(
        `usage "${spec.slug}" est sensible (déploiement, secrets, paiement, production) : ` +
          `le modèle gratuit "${spec.candidates[freeIndex]!.model}" (rang ${freeIndex}) est refusé. ` +
          "Corrigez la liste de candidats : les usages sensibles n'ont jamais de candidat gratuit.",
      )
    }
  }

  // HARD RULE 2 — the 2-free-agents-local cap, overflow ⇒ sandbox.
  // Redirect gate: the DEFAULT candidate is FREE (a paid-first chain has
  // no free-agent overflow to relieve — paid locals don't bleed the local
  // IP). The redirect keeps the model free (that's the point of the
  // overflow) but moves it INTO the box, whose IP isn't the one that bled.
  const first = spec.candidates[0]!
  const inUse = opts.freeLocalInUse ?? 0
  const overflow =
    spec.placePolicy === "local-preferred" &&
    isFreeCandidate(first) &&
    inUse >= MAX_LOCAL_FREE_AGENTS

  const place: Place =
    spec.placePolicy === "sandbox" || overflow ? "sandbox" : "local"

  // Selection is place-aware: the first candidate valid for the chosen
  // place wins. The overflow redirect additionally requires a free,
  // explicitly sandbox-capable candidate, so it never silently swaps in a
  // local-declared model.
  const candidate = overflow
    ? candidateForPlace(spec, "sandbox", { freeOnly: true })
    : candidateForPlace(spec, place)

  const warning = overflow
    ? `Limite atteinte : ${inUse} agents gratuits tournent déjà en local ` +
      `(max ${MAX_LOCAL_FREE_AGENTS} — l'IP locale est limitée au-delà). ` +
      `Agent gratuit redirigé vers la sandbox (modèle gratuit ok dans la box : l'IP qui saignait était la locale).`
    : undefined

  return {
    usage: spec.slug,
    resolvedModel: candidate.model,
    profileRef: candidate.profileRef,
    adapter,
    posture: candidate.posture,
    place,
    ...(place === "sandbox"
      ? { sandbox: { provider: spec.sandboxProvider ?? "computer" } }
      : {}),
    fallbackUsed: spec.candidates.indexOf(candidate),
    spawn: buildSpawn(adapter, candidate, place, spec),
    ...(warning ? { warning } : {}),
  }
}
