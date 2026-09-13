/**
 * Per-workspace state buckets — AIP-46 §State partitioning.
 *
 * AIP-46's premise is "a single host serve many bound directories", and
 * §Workspaces delivered the addressing half of it: a slug resolves to a
 * path. The state those directories generate stayed pooled in one global
 * `~/.agentproto/sessions.json` with `workspaceSlug` demoted to a column
 * on each row — a label, not a boundary.
 *
 * What that costs is measurable rather than theoretical. `HISTORY_CAP`
 * bounds retention across the *union* of every workspace, so the cap is
 * spent by whoever was busiest. A store pooling a few hundred rows from
 * several workspaces sits at that ceiling in ordinary use, and the
 * workspace contributing a handful of them is one busy afternoon in a
 * NEIGHBOUR away from losing all of them — having done nothing itself.
 * The eviction is silent and lands on the quietest workspace.
 *
 * This module is the slug→bucket rule and nothing more:
 *
 *   ~/.agentproto/
 *   ├── workspaces.json          # the registry (workspaces-config.ts)
 *   └── workspaces/              # one bucket per workspace (here)
 *       ├── agentik-studio/sessions.json
 *       └── default/sessions.json
 *
 * The registry (a file) and the state (a directory) are deliberate
 * siblings: one names the workspaces, the other holds what each
 * accumulated.
 *
 * ## Membership is the validation
 *
 * `workspaceSlug` arrives on a spawn request — it is caller input
 * (`session-spawn.ts` passes `input.workspaceSlug` straight through when
 * an explicit `cwd` accompanies it, so nothing sanitises it on the way
 * to the descriptor). A bucket is a directory name. Joining the two
 * without a check hands the caller `../../` under the daemon's own state
 * root, as the daemon's UID.
 *
 * So a slug does not become a directory name by being cleaned up — it
 * becomes one by coming *back from* the registry lookup. The registry's
 * slugs were sanitised by `sanitizeSlug` on the way in, so the only
 * strings that ever reach the filesystem are ones the host itself
 * minted. An unregistered slug isn't rejected or escaped; it fails to
 * match and lands in `default` like any other unregistered work. This is
 * why the rule is membership rather than sanitisation: you cannot forget
 * to validate a value you never chose.
 *
 * ## What this does NOT buy
 *
 * Partitioning bounds what a workspace's state *costs* other workspaces.
 * It does not bound who may read it — every bucket is still served to
 * every authorised caller, because no workspace-scoped credential
 * exists to serve them differently (pairings carry no workspace concept
 * at all; the orchestrator scope-token's `session_list` is daemon-wide
 * by documented debt, `orchestrator-gateway.ts`). The files moved; the
 * access did not. AIP-46 §Security Considerations says this in the
 * negative — do not read this module as an isolation control.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { promises as fsp } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

import { loadWorkspacesConfigSync } from "./workspaces-config.js"

/** The bucket every record lands in when its slug doesn't resolve —
 *  absent, empty, or naming a workspace that isn't registered.
 *
 *  A real bucket, not an error state. Refusing to persist an
 *  unregistered session would make this a breaking change for every
 *  one-off `cwd` spawn, and the obvious workaround (auto-register)
 *  turns a registry of the user's intent into a registry of everything
 *  that ever ran. The cost is stated plainly in the AIP: `default`'s
 *  occupants get no separation from *each other* — registering a
 *  workspace is what buys that. */
export const DEFAULT_BUCKET = "default"

/** Root of the per-workspace state buckets. Sibling of the
 *  `workspaces.json` registry that names them. */
export const BUCKETS_ROOT = (): string =>
  resolve(homedir(), ".agentproto", "workspaces")

/** The pre-partition global snapshot. Still read (to migrate from) and
 *  never written after the split — see `migrateLegacySessionsFile`. */
export const LEGACY_SESSIONS_FILE = (): string =>
  resolve(homedir(), ".agentproto", "sessions.json")

/** Marker recording that the legacy split already ran. Its presence —
 *  not the legacy file's absence — is what makes migration
 *  once-and-only-once, so a user who deletes rows from a bucket doesn't
 *  get them resurrected on the next boot. */
export const migrationMarkerPath = (root: string): string =>
  join(root, ".migration.json")

export const bucketDir = (root: string, slug: string): string =>
  join(root, slug)

export const bucketSessionsFile = (root: string, slug: string): string =>
  join(root, slug, "sessions.json")

/** Per-bucket transcript directory (AIP-46 §Layout).
 *
 *  Not yet wired: the registry still writes transcripts to the shared
 *  `~/.agentproto/sessions/`. Moving them needs the read side to move
 *  too, and several readers currently ignore the configured base dir
 *  entirely (`http-server.ts` and `transcript-export.ts` call
 *  `sessionEventsPath(id)` with no `baseDir`, so they resolve off
 *  `homedir()` regardless) — a pre-existing bug that a partial move
 *  would turn into missing transcripts. Exported so the follow-up has
 *  the path rule in one place. The AIP makes transcripts a SHOULD, not
 *  a MUST, for exactly this reason. */
export const bucketTranscriptDir = (root: string, slug: string): string =>
  join(root, slug, "sessions")

/** Defence in depth behind the membership check. `sanitizeSlug` already
 *  guarantees this shape for anything in the registry, so a failure here
 *  means the registry itself was written by something that bypassed it. */
const SAFE_BUCKET_SLUG = /^[a-z0-9_][a-z0-9_-]{0,63}$/

export const isSafeBucketSlug = (slug: string): boolean =>
  SAFE_BUCKET_SLUG.test(slug)

/**
 * The slug→bucket rule (AIP-46 §Bucket resolution).
 *
 * 1. non-empty AND registered → that workspace's bucket
 * 2. otherwise → `default`
 *
 * `registered` must come from the workspaces registry. Passing a set
 * built from caller input defeats the entire point of this function.
 */
export function resolveBucketSlug(
  workspaceSlug: string | undefined | null,
  registered: ReadonlySet<string>,
): string {
  if (!workspaceSlug) return DEFAULT_BUCKET
  if (!registered.has(workspaceSlug)) return DEFAULT_BUCKET
  // Unreachable for a registry written through `addWorkspace`; cheap
  // enough to keep as the last thing standing between caller input and
  // a path join.
  if (!isSafeBucketSlug(workspaceSlug)) return DEFAULT_BUCKET
  return workspaceSlug
}

/** Registered slugs, read fresh. Cheap (the registry is <1KB) and read
 *  per persist rather than cached at boot, so a workspace registered
 *  while the daemon is up starts bucketing immediately instead of
 *  silently pooling into `default` until restart. Never throws: a
 *  missing/corrupt registry degrades to "nothing is registered", i.e.
 *  everything lands in `default` — today's pooled behaviour, which is
 *  the right failure direction.
 *
 *  A registry read that fails transiently (a race with a concurrent
 *  `saveWorkspacesConfig` tmp+rename) is indistinguishable here from one
 *  that's genuinely empty — but the persist path never actually needs to
 *  tell them apart: `sessions.ts`'s `sourceBucketOf` already keeps a
 *  loaded row homed to the bucket it came from regardless of what this
 *  returns, so a bad read here degrades a NEW session's placement (still
 *  `default`, same as always) and nothing else. See the 2026-07-18
 *  bucket-clobber incident for why that distinction matters for loaded
 *  rows, and `sourceBucketOf`'s docblock in `sessions.ts` for where it's
 *  actually enforced. */
export function readRegisteredSlugs(configPath?: string): ReadonlySet<string> {
  try {
    const config = loadWorkspacesConfigSync(configPath)
    return new Set(config.workspaces.map(w => w.slug))
  } catch {
    return new Set()
  }
}

/** Bucket directories that exist on disk. Order is not meaningful. */
export function listBuckets(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory() && isSafeBucketSlug(e.name))
      .map(e => e.name)
  } catch {
    return [] // ENOENT — nothing partitioned yet.
  }
}

export interface BucketSnapshot {
  savedAt: string
  sessions: unknown[]
}

const serialize = (snapshot: BucketSnapshot): string =>
  JSON.stringify(snapshot, null, 2) + "\n"

/** Monotonic per-process sequence for tmp-file names. A pid-only suffix
 *  is NOT unique within one process: two in-flight writes to the same
 *  bucket share the path, and the interleaving `A:write → B:write(O_TRUNC)
 *  → A:rename` promotes B's half-written file to `sessions.json` (B's
 *  own rename then fails ENOENT — the observed "persist failed" storm,
 *  2026-08-14 registry wipe). If the process dies before B finishes, the
 *  truncated JSON is what the next boot reads. pid+seq makes every write
 *  own its tmp file, so a rename can only ever promote a fully-written
 *  snapshot. */
let tmpSeq = 0

const tmpPathFor = (target: string): string =>
  `${target}.tmp.${process.pid}.${++tmpSeq}`

/** Atomic bucket write (tmp + rename), mirroring `saveWorkspacesConfig`
 *  — a concurrent reader never sees half a JSON object, and concurrent
 *  writers never share a tmp path (see `tmpSeq`). */
export async function writeBucketSnapshot(
  root: string,
  slug: string,
  snapshot: BucketSnapshot,
): Promise<void> {
  const dir = bucketDir(root, slug)
  await fsp.mkdir(dir, { recursive: true })
  const target = bucketSessionsFile(root, slug)
  const tmp = tmpPathFor(target)
  await fsp.writeFile(tmp, serialize(snapshot), "utf8")
  await fsp.rename(tmp, target)
}

/** Sync twin for the shutdown path, where Node won't await. */
export function writeBucketSnapshotSync(
  root: string,
  slug: string,
  snapshot: BucketSnapshot,
): void {
  const dir = bucketDir(root, slug)
  mkdirSync(dir, { recursive: true })
  const target = bucketSessionsFile(root, slug)
  const tmp = tmpPathFor(target)
  writeFileSync(tmp, serialize(snapshot), "utf8")
  renameSync(tmp, target)
}

export interface MigrationMarker {
  version: 1
  migratedAt: string
  /** Absolute path of the legacy artifact this split read from. Left
   *  untouched on disk — recorded so the provenance survives. */
  from: string
  /** Total records read out of the legacy artifact. */
  rows: number
  /** Records landed, per bucket. Sums to `rows` — the migration never
   *  drops a record it cannot place; it sends it to `default`. */
  byBucket: Record<string, number>
}

interface LegacyRow {
  id?: unknown
  workspaceSlug?: unknown
  startedAt?: unknown
}

/**
 * Split the legacy global snapshot into buckets (AIP-46 §Migration).
 *
 * **Additive by mandate.** The legacy file is opened read-only and left
 * exactly where it is — never deleted, truncated, or rewritten. It is
 * the user's data and their only rollback; the buckets are a derivative
 * until they decide otherwise. Reclaiming it is a separate, human-gated
 * call, and this module deliberately ships no GC: a real store is backed
 * by a transcript directory that can reach hundreds of megabytes and may
 * be someone's only copy of months of work — a deleter that guesses
 * wrong there is unrecoverable.
 *
 * Idempotent via the marker, not via the legacy file's absence — the
 * file stays, so absence would never fire and every boot would re-import
 * rows the user had since deleted from a bucket.
 *
 * Returns the marker it wrote, or `null` when there was nothing to do
 * (already migrated, or no legacy file).
 */
export function migrateLegacySessionsFile(opts: {
  root: string
  legacyFile: string
  registered: ReadonlySet<string>
}): MigrationMarker | null {
  const { root, legacyFile, registered } = opts

  // Already split — the marker is the authority, see docblock.
  try {
    readFileSync(migrationMarkerPath(root), "utf8")
    return null
  } catch {
    // ENOENT — not yet migrated, carry on.
  }

  let raw: string
  try {
    raw = readFileSync(legacyFile, "utf8")
  } catch {
    return null // No legacy artifact — nothing to migrate, ever.
  }

  let parsed: { sessions?: LegacyRow[] }
  try {
    parsed = JSON.parse(raw) as { sessions?: LegacyRow[] }
  } catch {
    console.warn(
      `[buckets] legacy history ${legacyFile} is malformed — leaving it in ` +
        `place and starting with empty buckets`,
    )
    return null
  }
  if (!Array.isArray(parsed.sessions)) return null

  const rows = parsed.sessions.filter(
    (r): r is LegacyRow => !!r && typeof r.id === "string",
  )

  const groups = new Map<string, LegacyRow[]>()
  for (const row of rows) {
    const slug = resolveBucketSlug(
      typeof row.workspaceSlug === "string" ? row.workspaceSlug : undefined,
      registered,
    )
    const list = groups.get(slug)
    if (list) list.push(row)
    else groups.set(slug, [row])
  }

  const savedAt = new Date().toISOString()
  const byBucket: Record<string, number> = {}
  for (const [slug, bucketRows] of groups) {
    // Merge rather than clobber: a bucket file shouldn't exist on a
    // first migration, but if one does (a half-finished earlier attempt,
    // a hand-placed file), what's already in the bucket is newer than
    // what's in the legacy artifact and wins.
    const existing = readBucketRows(root, slug)
    const seen = new Set(existing.map(r => String((r as LegacyRow).id)))
    const merged = [
      ...existing,
      ...bucketRows.filter(r => !seen.has(String(r.id))),
    ]
    writeBucketSnapshotSync(root, slug, { savedAt, sessions: merged })
    byBucket[slug] = bucketRows.length
  }

  const marker: MigrationMarker = {
    version: 1,
    migratedAt: savedAt,
    from: legacyFile,
    rows: rows.length,
    byBucket,
  }
  mkdirSync(root, { recursive: true })
  writeFileSync(
    migrationMarkerPath(root),
    JSON.stringify(marker, null, 2) + "\n",
    "utf8",
  )
  console.warn(
    `[buckets] partitioned ${rows.length} session rows from ${legacyFile} ` +
      `into ${Object.keys(byBucket).length} bucket(s): ` +
      `${Object.entries(byBucket)
        .map(([s, n]) => `${s}=${n}`)
        .join(", ")}. The original file is left untouched.`,
  )
  return marker
}

/** Rows currently on disk for a bucket. `[]` for a missing/corrupt/empty
 *  file — same "degrade to nothing rather than throw" contract as every
 *  other reader in this module. Exported so a persist path can consult
 *  what's already there before writing — see `mergeBucketRows`. */
export function readBucketRows(root: string, slug: string): unknown[] {
  try {
    const parsed = JSON.parse(
      readFileSync(bucketSessionsFile(root, slug), "utf8"),
    ) as { sessions?: unknown[] }
    return Array.isArray(parsed.sessions) ? parsed.sessions : []
  } catch {
    return []
  }
}

const rowId = (row: unknown): string | undefined =>
  row && typeof row === "object" && "id" in row && typeof (row as { id?: unknown }).id === "string"
    ? (row as { id: string }).id
    : undefined

/**
 * Merge freshly-computed rows for a bucket with whatever is already on
 * disk, deduped by id. `rows` wins for any id it carries (it reflects
 * this process's more current view of that session — status, endedAt,
 * etc.).
 *
 * An on-disk row whose id has no counterpart in `rows` is preserved ONLY
 * when `everHeldIds` says this daemon process has NEVER itself held that
 * id in this bucket — i.e. it is genuinely FOREIGN, written by some
 * other process. Exists so a persist can never SHRINK a bucket purely
 * because this daemon instance's in-memory registry doesn't hold every
 * row that bucket's file holds — the case a daemon that never loaded a
 * bucket at boot (a second/skewed-build instance, a workspace-scoped
 * boot load) hits when a new session happens to resolve into it.
 *
 * The `everHeldIds` check is what stops that same backstop from
 * resurrecting a session THIS daemon deliberately forgot: an id it once
 * held (loaded at boot, or created itself) but no longer carries in
 * `rows` was removed on purpose, not lost to a partial view of the
 * bucket, and must not come back just because it's still sitting on disk
 * from a moment before that removal was persisted. `everHeldIds` is
 * expected to grow monotonically over the caller's lifetime — an id, once
 * added, is never removed from it even after the session itself is
 * forgotten — precisely so this distinction survives the forget.
 *
 * Callers that DID authoritatively load a bucket at boot are expected to
 * pass its rows through unmerged — this is a backstop for the buckets
 * they didn't.
 */
export function mergeBucketRows(
  onDisk: readonly unknown[],
  rows: readonly unknown[],
  everHeldIds: ReadonlySet<string>,
): unknown[] {
  const incomingIds = new Set(rows.map(rowId).filter((id): id is string => id !== undefined))
  const preserved = onDisk.filter(row => {
    const id = rowId(row)
    return id !== undefined && !incomingIds.has(id) && !everHeldIds.has(id)
  })
  return [...rows, ...preserved]
}
