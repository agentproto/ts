/**
 * Typed, best-effort persistence for the last-seen provider "remaining quota"
 * per auth profile — the durable fallback the {@link RemainingQuotaReader}
 * reads from when a live provider fetch times out or fails.
 *
 * Mirrors the persistence primitives `@agentproto/auth`'s `profile-store.ts`
 * already established (a versioned `{ version: 1, … }` JSON file under
 * `~/.agentproto/`, `node:fs/promises`, mode 0600) rather than inventing a new
 * format — just a different filename (`usage-quota.json`) and shape. Like that
 * store, a missing or corrupt file reads as empty and NEVER throws on read, so
 * a half-written quota cache can't sink a rollup that only wanted an estimate.
 *
 * `dir` is injectable on every function purely so tests can round-trip against
 * a temp directory instead of the real home path.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"
import type { RemainingQuota } from "./remaining-quota.js"

/** The last-seen per-window remaining quota for one auth profile, keyed by
 *  `profileRef`. `fetchedAt` is when the enclosed values were last observed
 *  from the provider — stamped by the reader, never fabricated. */
export interface StoredProfileQuota {
  profileRef: string
  windows: { "5h"?: RemainingQuota; "7d"?: RemainingQuota }
  fetchedAt: string
}

const remainingQuotaSchema = z.object({
  window: z.string(),
  remaining: z.number(),
  resetsAt: z.string(),
  basis: z.literal("provider"),
}) satisfies z.ZodType<RemainingQuota>

const storedProfileQuotaSchema = z.object({
  profileRef: z.string(),
  windows: z.object({
    "5h": remainingQuotaSchema.optional(),
    "7d": remainingQuotaSchema.optional(),
  }),
  fetchedAt: z.string(),
}) satisfies z.ZodType<StoredProfileQuota>

const quotaFileSchema = z.object({
  version: z.literal(1),
  profiles: z.record(z.string(), storedProfileQuotaSchema),
})

/** Version-1 on-disk shape: `{ version: 1, profiles: { [profileRef]: … } }`. */
export type QuotaStoreFile = z.infer<typeof quotaFileSchema>

/** Options accepted by every store fn. `dir` overrides the `~/.agentproto`
 *  home directory (tests inject a temp dir). */
export interface QuotaStoreOptions {
  dir?: string
}

function quotaDir(opts?: QuotaStoreOptions): string {
  return opts?.dir ?? resolve(homedir(), ".agentproto")
}

function quotaPath(opts?: QuotaStoreOptions): string {
  return join(quotaDir(opts), "usage-quota.json")
}

function emptyFile(): QuotaStoreFile {
  return { version: 1, profiles: {} }
}

/** Load the whole store. ENOENT / malformed / schema-mismatch → empty file.
 *  Never throws. */
export async function loadQuotaStore(opts?: QuotaStoreOptions): Promise<QuotaStoreFile> {
  try {
    const raw = await readFile(quotaPath(opts), "utf8")
    return quotaFileSchema.parse(JSON.parse(raw))
  } catch {
    return emptyFile()
  }
}

/** Read a single profile's last-seen quota, or undefined if absent. Never
 *  throws (delegates to {@link loadQuotaStore}). */
export async function readProfileQuota(
  profileRef: string,
  opts?: QuotaStoreOptions,
): Promise<StoredProfileQuota | undefined> {
  const file = await loadQuotaStore(opts)
  return file.profiles[profileRef]
}

/** Upsert one profile's last-seen quota, keyed by `entry.profileRef`. May
 *  throw on a genuine write failure (callers wrap this best-effort). */
export async function recordProfileQuota(
  entry: StoredProfileQuota,
  opts?: QuotaStoreOptions,
): Promise<void> {
  const file = await loadQuotaStore(opts)
  file.profiles[entry.profileRef] = entry
  const dir = quotaDir(opts)
  await mkdir(dir, { recursive: true })
  // mode 0600 so other local users can't read the cached quota.
  await writeFile(quotaPath(opts), JSON.stringify(file, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  })
}
