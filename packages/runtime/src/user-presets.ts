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
}

const userPresetSchema = z.object({
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
 * boundary for CLI, MCP and editor callers. */
export async function saveUserPreset(preset: UserPreset): Promise<void> {
  const validated = userPresetSchema.parse(preset)
  const file = await loadUserPresets()
  const index = file.presets.findIndex(existing => existing.id === validated.id)
  if (index === -1) file.presets.push(validated)
  else file.presets[index] = validated
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
