/**
 * User-owned spawn presets.
 *
 * This is deliberately separate from `preset-tools.ts`: provider presets are
 * static gateway definitions shipped by packages, while a UserPreset is a
 * private saved combination of the orthogonal session-config axes.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"
import type {
  ContextProfile,
  EffortLevel,
  Posture,
  RouteSpec,
  SessionConfig,
} from "./session-config.js"
import type { SpawnBrowserMode } from "./browser-mount.js"
import type { SessionDescriptor } from "./sessions.js"
import { turnRetryInputSchema, type TurnRetryInput } from "./turn-retry-policy.js"

const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max", "ultracode"])
const postureSchema = z.union([
  z.enum(["default", "plan", "accept-edits", "bypass", "read-only"]),
  z.object({ harnessModeId: z.string().min(1) }),
])
const routeSchema = z.object({
  gateway: z.string().min(1),
  baseUrl: z.string().url().optional(),
})

/** A reusable, user-scoped subset of the spawn/session config axes. */
export interface UserPreset extends Partial<SessionConfig> {
  /** Stable machine-local id, e.g. `fast-deepseek`. */
  id: string
  /** Human-readable name shown by CLI and editor pickers. */
  label: string
  /** Adapter harness to use. Omitted means the caller selects one. */
  adapter?: string
  /** Canonical harness slug — alias for `adapter`. */
  harness?: string
  model?: string
  route?: RouteSpec
  access?: { profileRef?: string }
  posture?: Posture
  effort?: EffortLevel
  contextProfile?: ContextProfile
  /** Working directory the favorite pins to. When set, a spawn from this
   *  preset lands here regardless of the caller's active folder — the axis
   *  that makes a favorite fully location-pinned (true zero-input). Omitted
   *  means the caller's cwd ladder resolves it as before. */
  cwd?: string
  /** Skills to preload for a spawn from this preset — the same axis as
   *  `SpawnAgentSessionInput.skills`. Omitted means the adapter/defaults
   *  decide. */
  skills?: string[]
  /** Capability bundle ids (`bundle_list`) for a spawn from this preset — the
   *  same axis as `SpawnAgentSessionInput.bundles`. Omitted means the
   *  adapter/defaults decide. */
  bundles?: string[]
  /** `agent_start.browser` for spawns from this preset. Ranks below the
   *  role's own default (see `resolveBrowserMode`). */
  browser?: SpawnBrowserMode
  /** `agent_start.turnRetry` for spawns from this preset (opt-in retry of a
   *  turn that failed on a transient provider error). An explicit
   *  `turnRetry` on the spawn wins. */
  turnRetry?: TurnRetryInput
  /** ISO 8601 timestamp of the last spawn that resolved a `presetId` to this
   *  preset (agent_start, `/sessions/agent`, `/sessions/chat` — stamped once
   *  in `spawnAgentSession`, the shared core all three route through). Never
   *  set by a caller directly; `saveUserPreset` preserves the existing value
   *  across an edit unless the write explicitly overrides it. Absent for a
   *  preset that has never been used to spawn. */
  lastUsedAt?: string
}

export const userPresetSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  label: z.string().min(1),
  adapter: z.string().min(1).optional(),
  harness: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  route: routeSchema.optional(),
  access: z.object({ profileRef: z.string().min(1).optional() }).optional(),
  posture: postureSchema.optional(),
  effort: effortSchema.optional(),
  contextProfile: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  skills: z.array(z.string().min(1)).optional(),
  bundles: z.array(z.string().min(1)).optional(),
  browser: z.union([z.literal("headless"), z.literal(false)]).optional(),
  turnRetry: turnRetryInputSchema.optional(),
  lastUsedAt: z.string().min(1).optional(),
}) satisfies z.ZodType<UserPreset>

const userPresetsFileSchema = z.object({
  version: z.literal(1),
  presets: z.array(userPresetSchema),
})

export type UserPresetsFile = z.infer<typeof userPresetsFileSchema>

function emptyFile(): UserPresetsFile {
  return { version: 1, presets: [] }
}

export function userPresetsPath(): string {
  return resolve(homedir(), ".agentproto", "presets.json")
}

/** Missing or malformed user config is treated as empty — a bad preset must
 * never prevent the daemon from starting. Writes always restore valid JSON. */
export async function loadUserPresets(): Promise<UserPresetsFile> {
  try {
    return userPresetsFileSchema.parse(JSON.parse(await readFile(userPresetsPath(), "utf8")))
  } catch {
    return emptyFile()
  }
}

async function writeUserPresets(file: UserPresetsFile): Promise<void> {
  const dir = join(homedir(), ".agentproto")
  await mkdir(dir, { recursive: true })
  await writeFile(userPresetsPath(), JSON.stringify(file, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  })
}

export async function listUserPresets(): Promise<UserPreset[]> {
  return (await loadUserPresets()).presets
}

export async function getUserPreset(id: string): Promise<UserPreset | undefined> {
  return (await loadUserPresets()).presets.find(preset => preset.id === id)
}

/** Add or replace a preset by id. The parser makes this the single validation
 * boundary for CLI, MCP and editor callers. An edit that doesn't name its own
 * `lastUsedAt` keeps the existing preset's stamp rather than wiping it — a
 * rename/retune of a favorite must not erase its recency. */
export async function saveUserPreset(preset: UserPreset): Promise<void> {
  const validated = userPresetSchema.parse(preset)
  const file = await loadUserPresets()
  const index = file.presets.findIndex(existing => existing.id === validated.id)
  const lastUsedAt = validated.lastUsedAt ?? (index === -1 ? undefined : file.presets[index]?.lastUsedAt)
  const next: UserPreset = { ...validated, ...(lastUsedAt ? { lastUsedAt } : {}) }
  if (index === -1) file.presets.push(next)
  else file.presets[index] = next
  await writeUserPresets(file)
}

export async function deleteUserPreset(id: string): Promise<boolean> {
  const file = await loadUserPresets()
  const index = file.presets.findIndex(preset => preset.id === id)
  if (index === -1) return false
  file.presets.splice(index, 1)
  await writeUserPresets(file)
  return true
}

/** Stamp `lastUsedAt` on the preset a spawn just resolved `presetId` to.
 * Best-effort: an unknown id is a no-op, and a write failure here must never
 * fail the spawn it's timestamping — callers should await it inside a
 * `.catch(() => {})`. */
export async function touchUserPreset(id: string): Promise<void> {
  const file = await loadUserPresets()
  const index = file.presets.findIndex(preset => preset.id === id)
  if (index === -1) return
  file.presets[index] = { ...file.presets[index]!, lastUsedAt: new Date().toISOString() }
  await writeUserPresets(file)
}

/** One de-duplicated recent spawn configuration, derived from session
 *  history rather than persisted — the `user_preset_list({ includeRecent:
 *  true })` / `GET /user-presets?includeRecent=1` companion view to actual
 *  favorites, so a caller can "save as favorite" something they've spawned
 *  before without retyping it. */
export interface RecentSpawnConfig {
  adapter?: string
  model?: string
  profileRef?: string
  cwd?: string
  /** Always true — the marker that distinguishes a derived row from a
   *  persisted {@link UserPreset} when the two are rendered in one list. */
  recent: true
}

/** Derive up to `limit` distinct recent spawn configurations (adapter,
 *  model, profileRef, cwd) from the registry's own newest-first session
 *  list. Only `agent-cli` sessions carry a spawn config; a session that
 *  named neither `harness` nor `adapterSlug` is skipped (nothing to offer
 *  as a favorite). Distinctness is by the exact (adapter, model, profileRef,
 *  cwd) tuple, keeping only the most recent occurrence of each. */
export function deriveRecentSpawnConfigs(
  descriptors: readonly SessionDescriptor[],
  limit = 5,
): RecentSpawnConfig[] {
  const seen = new Set<string>()
  const out: RecentSpawnConfig[] = []
  for (const desc of descriptors) {
    if (out.length >= limit) break
    if (desc.kind !== "agent-cli") continue
    const adapter = desc.harness ?? desc.adapterSlug
    if (!adapter) continue
    const config: Omit<RecentSpawnConfig, "recent"> = {
      adapter,
      ...(desc.model ? { model: desc.model } : {}),
      ...(desc.accessProfile?.profileRef ? { profileRef: desc.accessProfile.profileRef } : {}),
      ...(desc.cwd ? { cwd: desc.cwd } : {}),
    }
    const key = JSON.stringify(config)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...config, recent: true })
  }
  return out
}
