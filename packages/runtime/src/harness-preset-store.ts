/**
 * `~/.agentproto/harness-presets.json` — the persisted harness→profile binding
 * (mode 0600). A {@link HarnessPreset} names, per adapter harness, WHICH auth
 * profile and default model a fresh spawn should bill through, so the operator
 * no longer re-picks the profile every time (today that link lives only
 * ephemerally per-session `setSessionAccessProfile` or per-spawn in the
 * Configuration Lab picker).
 *
 * This is a POINTER store, like `auth-profiles.json` and
 * `llm-endpoint-links.json`, not a secret store: an entry holds a `profileRef`
 * (an {@link AuthProfile} id) and a `defaultModel` string, never a credential —
 * so it needs no encryption. It reuses the exact persistence primitives the
 * sibling stores established (a versioned JSON file under `~/.agentproto/`,
 * `node:fs/promises`, mode 0600, whole-file write) — see
 * `user-presets.ts` / `profile-store.ts` / `llm-endpoint-links-store.ts`.
 *
 * Invariants enforced on write (validated once, at this boundary, for every
 * CLI/MCP/editor caller):
 *   • at most one `isDefault: true` per `harnessSlug` — the spawn path reads
 *     exactly one default per harness (see `getDefaultHarnessPreset`);
 *   • `profileRef` must reference an EXISTING, ENABLED auth profile — a dangling
 *     or disabled profile can never become the silent default a spawn bills;
 *   • `defaultModel` must be serviceable by that profile's curation allowlist
 *     (a `mode: "allow"` profile only bills the models it lists).
 * The profile lookup is injected ({@link HarnessPresetValidationDeps}) so the
 * store is testable without touching the real auth-profile store; it defaults
 * to `@agentproto/auth`'s `getAuthProfile`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"
import { getAuthProfile, type AuthProfile } from "@agentproto/auth"

/**
 * A persisted harness→profile binding: for one adapter harness, which auth
 * profile + default model a fresh spawn bills through when the caller pins
 * neither explicitly.
 */
export interface HarnessPreset {
  /** Stable, machine-local id — unique across all presets (e.g. `hm-cheap`). */
  id: string
  /** Adapter harness slug this preset binds (e.g. `hermes`). Matched against a
   *  spawn's `harness ?? adapter`. */
  harnessSlug: string
  /** Human-readable display name (e.g. `Cheap`). */
  name: string
  /** The {@link AuthProfile} id this preset bills through — must exist and be
   *  enabled at write time. */
  profileRef: string
  /** Model id applied at spawn when the caller named none (e.g. `z-ai/glm-5.2`). */
  defaultModel: string
  /** Whether this is THE default preset for its `harnessSlug`. At most one per
   *  harness — enforced on write. */
  isDefault: boolean
}

const harnessPresetSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  harnessSlug: z.string().min(1),
  name: z.string().min(1),
  profileRef: z.string().min(1),
  defaultModel: z.string().min(1),
  isDefault: z.boolean(),
}) satisfies z.ZodType<HarnessPreset>

const harnessPresetsFileSchema = z.object({
  version: z.literal(1),
  presets: z.array(harnessPresetSchema),
})

export type HarnessPresetsFile = z.infer<typeof harnessPresetsFileSchema>

/** Thrown when a create/update violates a store invariant (unknown/disabled
 *  profile, a model the profile can't service, …). A validation failure, not
 *  an I/O failure — callers surface it as a rejected request, not a crash. */
export class HarnessPresetValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HarnessPresetValidationError"
  }
}

/** Injected profile lookup — lets the store validate `profileRef` without a
 *  hard dependency on the real auth-profile file (tests stub it). */
export interface HarnessPresetValidationDeps {
  getProfile: (id: string) => Promise<AuthProfile | undefined>
}

function defaultValidationDeps(): HarnessPresetValidationDeps {
  return { getProfile: getAuthProfile }
}

/** Fresh empty file each call — never share the `presets` array, or a later
 *  mutation leaks into every other load in-process (same defense the sibling
 *  stores' `emptyFile()` establish). */
function emptyFile(): HarnessPresetsFile {
  return { version: 1, presets: [] }
}

export function harnessPresetsPath(): string {
  return resolve(homedir(), ".agentproto", "harness-presets.json")
}

/** Missing or malformed config is treated as empty — a bad preset file must
 *  never prevent the daemon from spawning. Writes always restore valid JSON. */
export async function loadHarnessPresets(): Promise<HarnessPresetsFile> {
  try {
    return harnessPresetsFileSchema.parse(JSON.parse(await readFile(harnessPresetsPath(), "utf8")))
  } catch {
    return emptyFile()
  }
}

async function writeHarnessPresets(file: HarnessPresetsFile): Promise<void> {
  const dir = join(homedir(), ".agentproto")
  await mkdir(dir, { recursive: true })
  // mode 0600 to match the sibling stores even though this file holds no
  // secret — same-user-only is the house style.
  await writeFile(harnessPresetsPath(), JSON.stringify(file, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  })
}

/** List all presets, optionally filtered to one harness slug. */
export async function listHarnessPresets(harnessSlug?: string): Promise<HarnessPreset[]> {
  const { presets } = await loadHarnessPresets()
  return harnessSlug === undefined ? presets : presets.filter(p => p.harnessSlug === harnessSlug)
}

/** Look up a single preset by id, or undefined if none exists. */
export async function getHarnessPreset(id: string): Promise<HarnessPreset | undefined> {
  const { presets } = await loadHarnessPresets()
  return presets.find(p => p.id === id)
}

/** The default preset for `harnessSlug`, or undefined when none is marked. The
 *  spawn path reads this to fill an unpinned `access.profileRef` + model. */
export async function getDefaultHarnessPreset(
  harnessSlug: string,
): Promise<HarnessPreset | undefined> {
  const { presets } = await loadHarnessPresets()
  return presets.find(p => p.harnessSlug === harnessSlug && p.isDefault)
}

/** True when the profile's curation would service `model` — a `mode: "allow"`
 *  profile bills only the model ids it lists; `mode: "all"` (or no curation)
 *  services everything. Mirrors the intent of the catalog eligibility join,
 *  applied here as a create-time guard, not the runtime billing gate. */
function profileServicesModel(profile: AuthProfile, model: string): boolean {
  const models = profile.models
  if (!models || models.mode === "all") return true
  return models.ids.includes(model)
}

/** Validate a preset's `profileRef`/`defaultModel` against the live auth
 *  profiles. Throws {@link HarnessPresetValidationError} on any violation. */
async function validateProfileBinding(
  preset: HarnessPreset,
  deps: HarnessPresetValidationDeps,
): Promise<void> {
  const profile = await deps.getProfile(preset.profileRef)
  if (!profile) {
    throw new HarnessPresetValidationError(
      `profileRef "${preset.profileRef}" references no existing auth profile.`,
    )
  }
  if (profile.disabled) {
    throw new HarnessPresetValidationError(
      `profileRef "${preset.profileRef}" is disabled; a disabled profile cannot back a harness preset.`,
    )
  }
  if (!profileServicesModel(profile, preset.defaultModel)) {
    throw new HarnessPresetValidationError(
      `defaultModel "${preset.defaultModel}" is not in profile "${preset.profileRef}"'s model allowlist.`,
    )
  }
}

/**
 * Add or replace a preset by id. Validates the profile binding, then upserts.
 * When the incoming preset is `isDefault`, every OTHER preset for the same
 * `harnessSlug` is demoted first, preserving the one-default-per-harness
 * invariant even across a replace that flips an id's harness or default flag.
 */
export async function addHarnessPreset(
  preset: HarnessPreset,
  deps: HarnessPresetValidationDeps = defaultValidationDeps(),
): Promise<HarnessPreset> {
  const validated = harnessPresetSchema.parse(preset)
  await validateProfileBinding(validated, deps)
  const file = await loadHarnessPresets()
  if (validated.isDefault) {
    for (const p of file.presets) {
      if (p.harnessSlug === validated.harnessSlug && p.id !== validated.id) p.isDefault = false
    }
  }
  const index = file.presets.findIndex(p => p.id === validated.id)
  if (index === -1) file.presets.push(validated)
  else file.presets[index] = validated
  await writeHarnessPresets(file)
  return validated
}

/** Partial update of an existing preset. Re-validates the resulting profile
 *  binding and re-applies the one-default invariant. Returns the updated
 *  preset, or undefined when `id` doesn't exist. */
export async function updateHarnessPreset(
  id: string,
  patch: Partial<Omit<HarnessPreset, "id">>,
  deps: HarnessPresetValidationDeps = defaultValidationDeps(),
): Promise<HarnessPreset | undefined> {
  const existing = await getHarnessPreset(id)
  if (!existing) return undefined
  return addHarnessPreset({ ...existing, ...patch, id }, deps)
}

/** Remove a preset by id. Returns true if it existed. */
export async function removeHarnessPreset(id: string): Promise<boolean> {
  const file = await loadHarnessPresets()
  const index = file.presets.findIndex(p => p.id === id)
  if (index === -1) return false
  file.presets.splice(index, 1)
  await writeHarnessPresets(file)
  return true
}

/**
 * Mark `presetId` as THE default for its harness, demoting every other preset
 * that shares its `harnessSlug`. Idempotent. Throws
 * {@link HarnessPresetValidationError} when `presetId` doesn't exist or when the
 * caller-supplied `harnessSlug` disagrees with the preset's own — the latter
 * guards against defaulting a preset under the wrong harness by a stale id.
 */
export async function setDefaultPreset(
  harnessSlug: string,
  presetId: string,
): Promise<HarnessPreset> {
  const file = await loadHarnessPresets()
  const target = file.presets.find(p => p.id === presetId)
  if (!target) {
    throw new HarnessPresetValidationError(`no harness preset "${presetId}" found.`)
  }
  if (target.harnessSlug !== harnessSlug) {
    throw new HarnessPresetValidationError(
      `preset "${presetId}" belongs to harness "${target.harnessSlug}", not "${harnessSlug}".`,
    )
  }
  for (const p of file.presets) {
    if (p.harnessSlug === harnessSlug) p.isDefault = p.id === presetId
  }
  await writeHarnessPresets(file)
  return target
}
