/**
 * Pure session-config resolution (AIP-46 §Session config, presets and
 * fallback). Builds the effective config axis by axis from the layers, lowest
 * precedence first:
 *
 *   manifest -> host -> definition -> harness preset -> preset (defaultFor,
 *   then the named preset after its extends chain) -> request
 *
 * Each axis is replaced whole by the highest layer that sets it, except:
 * `options` merges key by key, `tags` union, and `modelPolicy` entries
 * accumulate (both apply). No I/O lives here, so the spawn path, the CLI and
 * the MCP tools all resolve a config through the same code.
 */

import {
  composeModelPolicies,
  type ModelPolicy,
} from "./model-policy.js"
import type {
  ContextProfile,
  EffortLevel,
  Posture,
  RouteSpec,
} from "./session-config.js"
import type { SpawnBrowserMode } from "./browser-mount.js"
import type { TurnRetryInput } from "./turn-retry-policy.js"
import type { UserPreset } from "./user-presets.js"

/** Every axis the resolver knows. Placement (sandbox, worktree) is out of
 *  scope by contract. */
export type SessionConfigAxis =
  | "harness"
  | "model"
  | "effort"
  | "access"
  | "route"
  | "posture"
  | "contextProfile"
  | "cwd"
  | "skills"
  | "bundles"
  | "browser"
  | "turnRetry"
  | "options"
  | "tags"
  | "modelPolicy"

/** Where an axis came from. `preset:<id>` is a named preset (or a member of
 *  its `extends` chain); `preset-default:<id>` is the `defaultFor` preset. */
export type SessionConfigLayer =
  | "manifest"
  | "host"
  | "definition"
  | "harness-preset"
  | `preset:${string}`
  | `preset-default:${string}`
  | "request"

export interface SessionConfigAxes {
  harness?: string
  model?: string
  effort?: EffortLevel
  access?: { profileRef?: string }
  route?: RouteSpec
  posture?: Posture
  contextProfile?: ContextProfile
  cwd?: string
  skills?: string[]
  bundles?: string[]
  browser?: SpawnBrowserMode
  turnRetry?: TurnRetryInput
  /** Harness-native options not covered by an axis; merged key by key. */
  options?: Record<string, unknown>
  /** Preset discovery tags; unioned across layers. */
  tags?: string[]
  /** This implementation's form of the AIP-38 policy. */
  modelPolicy?: ModelPolicy
}

export interface SessionConfigResolution {
  config: SessionConfigAxes
  /** The layer that produced each axis. Absent = no layer set it. */
  layers: Partial<Record<SessionConfigAxis, SessionConfigLayer>>
}

/** The legacy harness default (`harness-presets.json`) projected onto the
 *  session-config axes. It ranks below the `defaultFor` session preset. */
export interface HarnessPresetOverlay {
  id: string
  access?: { profileRef?: string }
  model?: string
  turnRetry?: TurnRetryInput
}

export interface ResolveSessionConfigInput {
  /** Explicit spawn request axes: the highest layer. */
  request?: SessionConfigAxes
  /** The user's session preset store. */
  presets?: readonly UserPreset[]
  /** The harness slug the request resolves to. */
  harness?: string
  /** Named preset id. `request.presetId` is accepted for convenience. */
  presetId?: string
  manifest?: SessionConfigAxes
  host?: SessionConfigAxes
  definition?: SessionConfigAxes
  harnessPreset?: HarnessPresetOverlay
}

/** Typed resolution failure (missing extends target or a cycle). Save-time
 *  validation in `user-presets.ts` also uses these codes. */
export class SessionPresetResolutionError extends Error {
  constructor(
    readonly code: "unknown_extends" | "extends_cycle",
    message: string,
  ) {
    super(message)
    this.name = "SessionPresetResolutionError"
  }
}

const REPLACED_AXES = [
  "harness",
  "model",
  "effort",
  "access",
  "route",
  "posture",
  "contextProfile",
  "cwd",
  "skills",
  "bundles",
  "browser",
  "turnRetry",
] as const satisfies readonly SessionConfigAxis[]

function presetById(presets: readonly UserPreset[], id: string): UserPreset {
  const preset = presets.find(entry => entry.id === id)
  if (!preset) {
    throw new SessionPresetResolutionError(
      "unknown_extends",
      `session preset "${id}" does not exist`,
    )
  }
  return preset
}

/** The preset followed by its `extends` ancestors, applied order: ancestors
 *  first, left to right, then the preset itself. Throws on a missing target
 *  or a cycle. */
export function presetChain(
  id: string,
  presets: readonly UserPreset[],
): UserPreset[] {
  const out: UserPreset[] = []
  const visiting: string[] = []

  const visit = (current: string): void => {
    const cycleAt = visiting.indexOf(current)
    if (cycleAt !== -1) {
      const cycle = [...visiting.slice(cycleAt), current].join(" -> ")
      throw new SessionPresetResolutionError(
        "extends_cycle",
        `session preset extends cycle: ${cycle}`,
      )
    }
    const preset = presetById(presets, current)
    visiting.push(current)
    for (const parent of preset.extends ?? []) visit(parent)
    visiting.pop()
    out.push(preset)
  }

  visit(id)
  return out
}

/** The preset whose `defaultFor` names `harness`, if any. Save-time
 *  validation keeps this unique; a hand-edited file resolves to the first. */
export function defaultPresetFor(
  harness: string | undefined,
  presets: readonly UserPreset[],
): UserPreset | undefined {
  if (!harness) return undefined
  return presets.find(preset => preset.defaultFor === harness)
}

/** A preset's flat fields with any nested `config` underneath them. Flat
 *  fields win when both name the same axis (AIP-46 migration note). */
export function presetAxes(preset: UserPreset): SessionConfigAxes {
  const nested = (preset.config ?? {}) as SessionConfigAxes
  const flat: SessionConfigAxes = {
    harness: preset.harness,
    model: preset.model,
    effort: preset.effort,
    access: preset.access,
    route: preset.route,
    posture: preset.posture,
    contextProfile: preset.contextProfile,
    cwd: preset.cwd,
    skills: preset.skills,
    bundles: preset.bundles,
    browser: preset.browser,
    turnRetry: preset.turnRetry,
    options: preset.options,
  }
  const merged: SessionConfigAxes = { ...nested }
  for (const axis of REPLACED_AXES) {
    const value = flat[axis]
    if (value !== undefined) (merged as Record<string, unknown>)[axis] = value
  }
  if (flat.options !== undefined) merged.options = { ...(nested.options ?? {}), ...flat.options }
  if (preset.tags !== undefined) merged.tags = preset.tags
  if (preset.modelPolicy !== undefined) merged.modelPolicy = preset.modelPolicy
  return merged
}

interface Accumulator {
  config: SessionConfigAxes
  layers: Partial<Record<SessionConfigAxis, SessionConfigLayer>>
}

function applyLayer(
  acc: Accumulator,
  axes: SessionConfigAxes | undefined,
  layer: SessionConfigLayer,
): void {
  if (!axes) return
  for (const axis of REPLACED_AXES) {
    const value = axes[axis]
    if (value !== undefined) {
      ;(acc.config as Record<string, unknown>)[axis] = value
      acc.layers[axis] = layer
    }
  }
  if (axes.options !== undefined) {
    acc.config.options = { ...(acc.config.options ?? {}), ...axes.options }
    acc.layers.options = layer
  }
  if (axes.tags !== undefined && axes.tags.length > 0) {
    acc.config.tags = [...new Set([...(acc.config.tags ?? []), ...axes.tags])]
    acc.layers.tags = layer
  }
  if (axes.modelPolicy !== undefined) {
    acc.config.modelPolicy = composeModelPolicies(acc.config.modelPolicy, axes.modelPolicy)
    acc.layers.modelPolicy = layer
  }
}

export function resolveSessionConfig(
  input: ResolveSessionConfigInput,
): SessionConfigResolution {
  const presets = input.presets ?? []
  const request = input.request ?? {}
  const namedId = input.presetId
  const namedPreset = namedId ? presets.find(preset => preset.id === namedId) : undefined
  const harness = input.harness ?? request.harness ?? namedPreset?.harness

  const acc: Accumulator = { config: {}, layers: {} }
  applyLayer(acc, input.manifest, "manifest")
  applyLayer(acc, input.host, "host")
  applyLayer(acc, input.definition, "definition")

  if (input.harnessPreset) {
    applyLayer(
      acc,
      {
        access: input.harnessPreset.access,
        model: input.harnessPreset.model,
        turnRetry: input.harnessPreset.turnRetry,
      },
      "harness-preset",
    )
  }

  const defaultPreset = defaultPresetFor(harness, presets)
  if (defaultPreset && defaultPreset.id !== namedId) {
    for (const entry of presetChain(defaultPreset.id, presets)) {
      applyLayer(acc, presetAxes(entry), `preset-default:${entry.id}`)
    }
  }

  if (namedId) {
    for (const entry of presetChain(namedId, presets)) {
      applyLayer(acc, presetAxes(entry), `preset:${entry.id}`)
    }
  }

  applyLayer(acc, request, "request")
  return acc
}
