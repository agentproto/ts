/**
 * Model roles — ONE place to say "which model does role X use".
 *
 * A role is a dotted name for a job a model does inside agentproto
 * (`review.small`, `review.large`, `review.pr`, `judge.session`, …).
 * Consumers (the repo-maintenance workflow, the session-steward, agent
 * manifests via `model: role:<name>`, and later the CI reviewer and the
 * local push gate) ask for the ROLE instead of hard-coding a model id, so
 * "use GLM for review" is one config edit, not five files in three formats.
 *
 * PRECEDENCE — the single definition (highest first):
 *   1. `input`      an explicit workflow/run input (`reviewModelSmall`, …)
 *   2. `workspace`  the repo's own `agentproto.json` → `models`
 *   3. `daemon`     `~/.agentproto/config.json` → `models`
 *   4. `preset`     the active named preset ({@link MODEL_ROLE_PRESETS}),
 *                   chosen by `modelRolePreset` in the daemon config or a
 *                   per-run `preset` — a one-key switch between model sets
 *   5. `default`    {@link DEFAULT_MODEL_ROLES} below — the only built-in table
 *
 * Every resolution reports which layer won (`source`). A layer value that is
 * empty or not a string / `{ model }` object is skipped, never fatal.
 *
 * This file is pure (no I/O) so the config schema can import it without a
 * cycle; the loaders + the `model_roles` MCP tool live in
 * `model-roles-tools.ts`.
 */

import { isKnownLlmId } from "@agentproto/model-catalog/llm"
import { resolveLlmModelRoute } from "@agentproto/model-catalog/route-identity"

/** Object form of a role value: a model id plus optional serving hints. */
export interface ModelRoleEntry {
  model: string
  /** Router/gateway the model should be reached through (e.g. `openrouter`). */
  route?: string
  /** Named auth profile to spawn the role's session with. */
  profile?: string
}

/** A role value as written in a config file: a bare model id, or an entry. */
export type ModelRoleValue = string | ModelRoleEntry

/** ROLE → value, the shape of the `models` block in every layer. */
export type ModelRolesConfig = Record<string, ModelRoleValue>

export type ModelRoleSource = "input" | "workspace" | "daemon" | "preset" | "default"

/** The built-in defaults — the ONLY hard-coded model ids for these jobs. */
export const DEFAULT_MODEL_ROLES: Readonly<Record<string, string>> = {
  /** Reviewer for a small residual (repo-maintenance `review` step). */
  "review.small": "claude-sonnet-5-5",
  /** Reviewer for a large residual + the retry reviewer. */
  "review.large": "claude-opus-5-5",
  /** CI pull-request reviewer (mirrors `.github/agentic-review.json`'s `reviewerModel`). */
  "review.pr": "openrouter/z-ai/glm-5.3-flash",
  /** The session-steward's agent judge. */
  "judge.session": "claude-sonnet-5-5",
}

/** One named model set for the review roles — switch them all with one key. */
export interface ModelRolePreset {
  description: string
  roles: Readonly<Record<string, string>>
}

/**
 * Named presets, selected by `modelRolePreset` (daemon config) or a per-run
 * `preset`. A preset fills only the roles it names; an explicit value in any
 * higher layer still wins. `opus` is the built-in default spelled out, so
 * switching back is one key too.
 */
export const MODEL_ROLE_PRESETS: Readonly<Record<string, ModelRolePreset>> = {
  opus: {
    description: "Sonnet for small residuals, Opus for large ones and retries (the built-in default).",
    roles: { "review.small": "claude-sonnet-5-5", "review.large": "claude-opus-5-5" },
  },
  sonnet: {
    description: "Sonnet for every review.",
    roles: { "review.small": "claude-sonnet-5-5", "review.large": "claude-sonnet-5-5" },
  },
  haiku: {
    description: "Haiku for every review: cheapest Claude option.",
    roles: { "review.small": "claude-haiku-5-5", "review.large": "claude-haiku-5-5" },
  },
  "go-free": {
    description: "OpenCode Go free model (longcat) for every review: zero cost, spawned on the opencode adapter.",
    roles: {
      "review.small": "opencode-go/longcat-2.5-preview-free",
      "review.large": "opencode-go/longcat-2.5-preview-free",
    },
  },
  "free-sonnet": {
    description: "OpenCode Go free model for small residuals, Sonnet for large ones and retries.",
    roles: { "review.small": "opencode-go/longcat-2.5-preview-free", "review.large": "claude-sonnet-5-5" },
  },
}

/** The preset names, for schemas and help text. */
export const MODEL_ROLE_PRESET_NAMES = Object.keys(MODEL_ROLE_PRESETS) as [string, ...string[]]

/**
 * The adapter a role's model has to run on, when the model id says so:
 * `opencode/…` and `opencode-go/…` ids only exist on the opencode adapter (an
 * `opencode-go/claude-*` id included), a bare `claude-*` id on claude-code.
 * Undefined leaves the consumer's own default (e.g. the agent manifest's).
 */
export function adapterForModelId(model: string): string | undefined {
  if (model.startsWith("opencode/") || model.startsWith("opencode-go/")) return "opencode"
  return model.startsWith("claude-") ? "claude-code" : undefined
}

/** Prefix an agent manifest's `model:` uses to reference a role. */
export const MODEL_ROLE_REF_PREFIX = "role:"

export interface ModelRoleContext {
  /** Explicit per-run values keyed by role (layer 1). */
  input?: Record<string, ModelRoleValue | undefined> | undefined
  /** The workspace/repo `models` block (layer 2). */
  workspace?: Record<string, unknown> | undefined
  /** The daemon config `models` block (layer 3). */
  daemon?: Record<string, unknown> | undefined
  /** Active preset name (layer 4); an unknown name is ignored. */
  preset?: string | undefined
}

export interface ResolvedModelRole {
  role: string
  model: string
  route?: string
  profile?: string
  /** Adapter the model id requires ({@link adapterForModelId}), when it requires one. */
  adapter?: string
  source: ModelRoleSource
}

/** Normalize one raw config value to an entry; undefined when unusable. */
export function normalizeModelRoleValue(raw: unknown): ModelRoleEntry | undefined {
  if (typeof raw === "string") {
    const model = raw.trim()
    return model ? { model } : undefined
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>
    if (typeof o.model !== "string" || !o.model.trim()) return undefined
    return {
      model: o.model.trim(),
      ...(typeof o.route === "string" && o.route.trim() ? { route: o.route.trim() } : {}),
      ...(typeof o.profile === "string" && o.profile.trim() ? { profile: o.profile.trim() } : {}),
    }
  }
  return undefined
}

/** `role:review.large` → `review.large`; undefined for a non-role string. */
export function parseModelRoleRef(ref: string): string | undefined {
  if (!ref.startsWith(MODEL_ROLE_REF_PREFIX)) return undefined
  const role = ref.slice(MODEL_ROLE_REF_PREFIX.length).trim()
  return role || undefined
}

function presetRoles(name: string | undefined): Readonly<Record<string, string>> | undefined {
  return name !== undefined && Object.hasOwn(MODEL_ROLE_PRESETS, name) ? MODEL_ROLE_PRESETS[name]!.roles : undefined
}

/**
 * Resolve ONE role through the precedence chain. `undefined` only when no
 * layer — including the built-in table — knows the role.
 */
export function resolveModelRole(role: string, ctx: ModelRoleContext = {}): ResolvedModelRole | undefined {
  const layers: Array<[ModelRoleSource, unknown]> = [
    ["input", ctx.input?.[role]],
    ["workspace", ctx.workspace?.[role]],
    ["daemon", ctx.daemon?.[role]],
    ["preset", presetRoles(ctx.preset)?.[role]],
    ["default", DEFAULT_MODEL_ROLES[role]],
  ]
  for (const [source, raw] of layers) {
    const entry = normalizeModelRoleValue(raw)
    if (entry) {
      const adapter = adapterForModelId(entry.model)
      return { role, ...entry, ...(adapter !== undefined ? { adapter } : {}), source }
    }
  }
  return undefined
}

/**
 * Every role in play — the built-in ones plus any a layer configures — each
 * resolved with its source, sorted by role name. `roles` narrows the list
 * (an unknown role with no value anywhere is simply omitted).
 */
export function listModelRoles(ctx: ModelRoleContext = {}, roles?: readonly string[]): ResolvedModelRole[] {
  const names =
    roles ??
    [
      ...new Set([
        ...Object.keys(DEFAULT_MODEL_ROLES),
        ...Object.keys(presetRoles(ctx.preset) ?? {}),
        ...Object.keys(ctx.daemon ?? {}),
        ...Object.keys(ctx.workspace ?? {}),
        ...Object.keys(ctx.input ?? {}),
      ]),
    ].sort()
  const out: ResolvedModelRole[] = []
  for (const role of names) {
    const resolved = resolveModelRole(role, ctx)
    if (resolved) out.push(resolved)
  }
  return out
}

/** True when the catalog can place `id` (bare id, `vendor/product[@route]`, or `openrouter/<id>`). */
export function isKnownModelId(id: string): boolean {
  const bare = id.replace(/@[^@/]+$/, "")
  const candidates = [id, bare, bare.replace(/^openrouter\//, "")]
  return candidates.some(c => {
    try {
      return isKnownLlmId(c) || resolveLlmModelRoute(c) !== undefined
    } catch {
      // the route parser throws on ids it can't parse (e.g. `openrouter/a/b`) — try the next form
      return false
    }
  })
}

/** The `{ role, model }` pairs in a `models` block whose id the catalog does not know. */
export function unknownModelRoleIds(models: unknown): Array<{ role: string; model: string }> {
  if (!models || typeof models !== "object" || Array.isArray(models)) return []
  const out: Array<{ role: string; model: string }> = []
  for (const [role, raw] of Object.entries(models as Record<string, unknown>)) {
    const entry = normalizeModelRoleValue(raw)
    if (entry && !isKnownModelId(entry.model)) out.push({ role, model: entry.model })
  }
  return out
}
