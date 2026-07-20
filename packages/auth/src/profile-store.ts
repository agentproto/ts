/**
 * Named auth-profile store — CRUD over `~/.agentproto/auth-profiles.json`
 * (mode 0600), generalizing `providers-store`'s single-key-per-provider file
 * (`packages/providers-store/src/index.ts:68-90`, `ProviderEntry`/
 * `ProvidersFile`) to N named `AuthProfile`s per billing endpoint, keyed by `id`.
 *
 * This is the profile-metadata store, not the credential store: entries hold
 * `credentialRef` (a pointer), never a secret, so — unlike `FileStore`
 * (`store/file-store.ts`) — this file needs no encryption. Reuses the exact
 * persistence primitives `providers-store` already established (a versioned
 * JSON file under `~/.agentproto/`, `node:fs/promises`, mode 0600) rather
 * than inventing a new format, just relocated to `@agentproto/auth` — the
 * correct home for named profiles per SPEC §1c (`providers.json` is the
 * degenerate one-key-per-provider case this generalizes).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"
import type { AuthMethod, AuthProfile } from "./profile-types.js"

const authMethodSchema = z.enum(["oauth-bearer", "api-key"]) satisfies z.ZodType<AuthMethod>

/** Version-1 on-disk shape. Keep `vendor` here permanently for compatibility:
 * callers only ever see the unambiguous in-memory `endpoint` field. */
const authProfileSchema = z.object({
  id: z.string(),
  vendor: z.string(),
  method: authMethodSchema,
  credentialRef: z.string(),
  label: z.string().optional(),
}).transform(({ vendor, ...profile }): AuthProfile => ({ ...profile, endpoint: vendor }))

const authProfilesFileSchema = z.object({
  version: z.literal(1),
  profiles: z.record(z.string(), authProfileSchema),
})

export type AuthProfilesFile = z.infer<typeof authProfilesFileSchema>

/** Fresh empty file each call — never share the `profiles` object, or a
 *  later mutation leaks into every other load in-process (same defense
 *  `providers-store`'s `emptyFile()` establishes). */
function emptyFile(): AuthProfilesFile {
  return { version: 1, profiles: {} }
}

export function authProfilesPath(): string {
  return resolve(homedir(), ".agentproto", "auth-profiles.json")
}

export async function loadAuthProfiles(): Promise<AuthProfilesFile> {
  try {
    const raw = await readFile(authProfilesPath(), "utf8")
    return authProfilesFileSchema.parse(JSON.parse(raw))
  } catch {
    return emptyFile() // ENOENT / malformed → empty
  }
}

async function writeAuthProfiles(file: AuthProfilesFile): Promise<void> {
  const dir = join(homedir(), ".agentproto")
  await mkdir(dir, { recursive: true })
  // mode 0600 so other local users can't read the profile metadata.
  const diskFile = {
    version: file.version,
    profiles: Object.fromEntries(
      Object.entries(file.profiles).map(([id, { endpoint, ...profile }]) => [
        id,
        { ...profile, vendor: endpoint },
      ]),
    ),
  }
  await writeFile(authProfilesPath(), JSON.stringify(diskFile, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  })
}

/** List all profiles, optionally filtered to one billing endpoint. */
export async function listAuthProfiles(endpoint?: string): Promise<AuthProfile[]> {
  const file = await loadAuthProfiles()
  const all = Object.values(file.profiles)
  return endpoint === undefined ? all : all.filter(p => p.endpoint === endpoint)
}

/** Look up a single profile by id, or undefined if none exists. */
export async function getAuthProfile(id: string): Promise<AuthProfile | undefined> {
  const file = await loadAuthProfiles()
  return file.profiles[id]
}

/** Add (or replace) a profile, keyed by its `id`. */
export async function addAuthProfile(profile: AuthProfile): Promise<void> {
  const file = await loadAuthProfiles()
  file.profiles[profile.id] = profile
  await writeAuthProfiles(file)
}

/** Remove a profile by id. Returns true if it existed. */
export async function removeAuthProfile(id: string): Promise<boolean> {
  const file = await loadAuthProfiles()
  if (!(id in file.profiles)) return false
  delete file.profiles[id]
  await writeAuthProfiles(file)
  return true
}
