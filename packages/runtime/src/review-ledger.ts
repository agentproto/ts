/**
 * Review ledger — the daemon-side record of every review attestation.
 *
 * Lives under the daemon state dir, NEVER in the reviewed repo's working
 * tree: `~/.agentproto/reviews/<repo-slug>/<manifestSha>/<binding>/<rangeSha>.json`
 * — the path IS the ledger key `(repoRemote, manifestSha, binding, rangeSha)`
 * (the repo slug is a filesystem-safe form of the normalized remote). One
 * file per key; a re-run of the same key overwrites it with the newer
 * attestation.
 *
 * Every attestation is recorded — including `incomplete` and dirty-tree ones,
 * so `review_ledger` shows the history honestly — but only a clean `pass` /
 * `block` is ever served back as a cache hit (see `lookupCached`).
 *
 * Each file is an {@link LedgerEntry}: the self-contained attestation (what
 * `review_export` writes out) plus host-local metadata that is NOT part of
 * what gets attested (the checkout path, the manifest path, the manifest's
 * `verdict.exportDir`).
 *
 * Beside each entry sits an optional `<rangeSha>.annotations.json`
 * ({@link LedgerAnnotations}): the MUTABLE follow-up layer — a PR link found
 * after the fact, and `review_pr` status snapshots appended over time. It is
 * never hashed into (or exported with) the attestation, so annotating an
 * entry can't disturb a signature over it.
 *
 * Same persistence primitives as the sibling JSON stores (`node:fs/promises`,
 * write-tmp + rename). The root is injectable so tests never touch
 * `~/.agentproto`.
 */

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  ledgerKeyOf,
  type Attestation,
  type LedgerKey,
  type ReviewPrRef,
  type RubricDigest,
} from "@agentproto/review"

/** Host-local metadata stored beside an attestation (never exported). */
export interface LedgerHostMeta {
  /** Absolute path of the checkout the review ran in. */
  repoRoot: string
  /** Absolute path of the REVIEW.md that was used. */
  manifestPath: string
  /** The manifest's `verdict.exportDir`, resolved against `repoRoot`. */
  exportDir?: string
}

export interface LedgerEntry {
  attestation: Attestation
  host: LedgerHostMeta
}

/** One `review_pr` status fetch. */
export interface PrStatusSnapshot {
  /** ISO timestamp of the fetch. */
  fetchedAt: string
  state: "open" | "merged" | "closed"
  reviews: Array<{ login: string; state: string; submittedAt: string }>
  checks?: Array<{ name: string; conclusion: string | null }>
  /** The PR's head commit at fetch time — absent from snapshots taken
   *  before this field existed. */
  headSha?: string
}

/** The mutable annotations sidecar of a ledger entry. */
export interface LedgerAnnotations {
  pr?: ReviewPrRef
  /** Oldest first — each `review_pr` call appends one. */
  prStatus?: PrStatusSnapshot[]
}

export interface ReviewLedgerFilter {
  repoRemote?: string
  rangeSha?: string
  binding?: string
  manifestSha?: string
  /** Keep only entries whose `attestation.requester.sessionId` is one of
   *  these — backs `review_ledger({requesterSessionId, subtree})`: a single
   *  id, or (with `subtree: true`) that session's whole subtree, resolved by
   *  the caller before reaching the ledger. Answered from an in-memory
   *  `requesterSessionId -> ledger keys` index (built lazily on first use,
   *  kept current on every `put()`), never a full re-scan. */
  requesterSessionIds?: readonly string[]
}

export interface ReviewLedger {
  /** Absolute root directory of the ledger. */
  readonly root: string
  put(entry: LedgerEntry): Promise<string>
  get(key: LedgerKey): Promise<LedgerEntry | undefined>
  /** A reusable verdict for `key`: a clean (not dirty) `pass`/`block` whose
   *  rubric digests still match. `incomplete` is never reused. */
  lookupCached(key: LedgerKey, rubrics: readonly RubricDigest[]): Promise<LedgerEntry | undefined>
  findByRunId(runId: string): Promise<LedgerEntry | undefined>
  /** Entries matching `filter`, newest first. */
  list(filter?: ReviewLedgerFilter): Promise<LedgerEntry[]>
  /** The annotations sidecar of `key` (`{}` when there is none). */
  getAnnotations(key: LedgerKey): Promise<LedgerAnnotations>
  /** Read-modify-write the annotations sidecar of `key`; returns the result. */
  updateAnnotations(key: LedgerKey, update: (current: LedgerAnnotations) => LedgerAnnotations): Promise<LedgerAnnotations>
}

/** Record `pr` as the entry's PR link (replacing any previous link). */
export const withPr =
  (pr: ReviewPrRef) =>
  (a: LedgerAnnotations): LedgerAnnotations => ({ ...a, pr })

/** Append one status snapshot. */
export const withPrStatus =
  (snapshot: PrStatusSnapshot) =>
  (a: LedgerAnnotations): LedgerAnnotations => ({ ...a, prStatus: [...(a.prStatus ?? []), snapshot] })

export const defaultReviewLedgerRoot = (): string => join(homedir(), ".agentproto", "reviews")

/** Filesystem-safe slug of a normalized repo remote
 *  (`github.com/agentproto/ts` → `github.com_agentproto_ts`). */
export function repoSlug(repoRemote: string): string {
  return repoRemote.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "repo"
}

function keyPath(root: string, key: LedgerKey): string {
  return join(root, repoSlug(key.repoRemote), key.manifestSha, key.binding, `${key.rangeSha}.json`)
}

const ANNOTATIONS_SUFFIX = ".annotations.json"

function annotationsPath(root: string, key: LedgerKey): string {
  return join(root, repoSlug(key.repoRemote), key.manifestSha, key.binding, `${key.rangeSha}${ANNOTATIONS_SUFFIX}`)
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await rename(tmp, path)
}

const sameRubrics = (a: readonly RubricDigest[], b: readonly RubricDigest[]): boolean => {
  const norm = (r: readonly RubricDigest[]) =>
    r
      .map((d) => `${d.check}\0${d.path}\0${d.sha256}`)
      .sort()
      .join("\n")
  return norm(a) === norm(b)
}

async function readEntry(path: string): Promise<LedgerEntry | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as LedgerEntry
    if (!parsed || typeof parsed !== "object" || !parsed.attestation) return undefined
    return parsed
  } catch {
    return undefined
  }
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    const ents = await readdir(dir, { withFileTypes: true })
    return ents.filter((e) => e.isDirectory()).map((e) => join(dir, e.name))
  } catch {
    return []
  }
}

async function jsonFiles(dir: string): Promise<string[]> {
  try {
    const ents = await readdir(dir, { withFileTypes: true })
    return ents
      .filter((e) => e.isFile() && e.name.endsWith(".json") && !e.name.endsWith(ANNOTATIONS_SUFFIX))
      .map((e) => join(dir, e.name))
  } catch {
    return []
  }
}

export function createReviewLedger(opts: { root?: string } = {}): ReviewLedger {
  const root = opts.root ?? defaultReviewLedgerRoot()
  /** Per-sidecar write chain: two concurrent `updateAnnotations` on one key
   *  in this process never lose an append. */
  const annotationLocks = new Map<string, Promise<unknown>>()

  // `requesterSessionId -> Set<entry file path>` — built once (a single full
  // scan) on first use by `list({requesterSessionIds})`, then kept current by
  // `indexRequester` on every `put()`. Never rescanned after that: a lookup
  // is index hits + a targeted `readEntry` per hit, not a directory walk.
  const requesterIndex = new Map<string, Set<string>>()
  let requesterIndexBuilt = false

  function indexRequester(entry: LedgerEntry): void {
    const sessionId = entry.attestation.requester?.sessionId
    if (!sessionId) return
    const path = keyPath(root, ledgerKeyOf(entry.attestation))
    let paths = requesterIndex.get(sessionId)
    if (!paths) {
      paths = new Set()
      requesterIndex.set(sessionId, paths)
    }
    paths.add(path)
  }

  async function ensureRequesterIndex(): Promise<void> {
    if (requesterIndexBuilt) return
    requesterIndexBuilt = true
    for (const entry of await scan({})) indexRequester(entry)
  }

  async function readAnnotations(key: LedgerKey): Promise<LedgerAnnotations> {
    try {
      const parsed = JSON.parse(await readFile(annotationsPath(root, key), "utf8")) as LedgerAnnotations
      return parsed && typeof parsed === "object" ? parsed : {}
    } catch {
      return {}
    }
  }

  async function scan(filter: ReviewLedgerFilter): Promise<LedgerEntry[]> {
    const repoDirs = filter.repoRemote ? [join(root, repoSlug(filter.repoRemote))] : await subdirs(root)
    const out: LedgerEntry[] = []
    for (const repoDir of repoDirs) {
      for (const manifestDir of await subdirs(repoDir)) {
        for (const bindingDir of await subdirs(manifestDir)) {
          for (const file of await jsonFiles(bindingDir)) {
            const entry = await readEntry(file)
            if (!entry) continue
            const a = entry.attestation
            if (filter.repoRemote !== undefined && a.target.repoRemote !== filter.repoRemote) continue
            if (filter.rangeSha !== undefined && a.rangeSha !== filter.rangeSha) continue
            if (filter.binding !== undefined && a.binding !== filter.binding) continue
            if (filter.manifestSha !== undefined && a.manifestSha !== filter.manifestSha) continue
            out.push(entry)
          }
        }
      }
    }
    return out.sort((x, y) => y.attestation.createdAt.localeCompare(x.attestation.createdAt))
  }

  return {
    root,
    async put(entry) {
      const path = keyPath(root, ledgerKeyOf(entry.attestation))
      // A re-run of the same key (an identical range re-reviewed, e.g. a
      // `nocache` request) OVERWRITES this one file — drop the old
      // requester's index pointer first when the new attestation's requester
      // differs, so a stale `sessionId -> path` entry never resolves to a
      // file that no longer attests that session.
      const previous = await readEntry(path)
      const prevSessionId = previous?.attestation.requester?.sessionId
      const nextSessionId = entry.attestation.requester?.sessionId
      if (prevSessionId && prevSessionId !== nextSessionId) requesterIndex.get(prevSessionId)?.delete(path)
      await writeJsonAtomic(path, entry)
      indexRequester(entry)
      return path
    },
    async get(key) {
      return readEntry(keyPath(root, key))
    },
    async lookupCached(key, rubrics) {
      const entry = await readEntry(keyPath(root, key))
      if (!entry) return undefined
      const a = entry.attestation
      if (a.verdict === "incomplete" || a.dirty) return undefined
      if (!sameRubrics(a.rubrics ?? [], rubrics)) return undefined
      return entry
    },
    async findByRunId(runId) {
      return (await scan({})).find((e) => e.attestation.runId === runId)
    },
    async list(filter = {}) {
      if (filter.requesterSessionIds === undefined) return scan(filter)
      await ensureRequesterIndex()
      const paths = new Set<string>()
      for (const sessionId of filter.requesterSessionIds) {
        for (const path of requesterIndex.get(sessionId) ?? []) paths.add(path)
      }
      const entries = (await Promise.all([...paths].map(readEntry))).filter((e): e is LedgerEntry => e !== undefined)
      const { requesterSessionIds: _requesterSessionIds, ...rest } = filter
      const filtered = entries.filter(entry => {
        const a = entry.attestation
        if (rest.repoRemote !== undefined && a.target.repoRemote !== rest.repoRemote) return false
        if (rest.rangeSha !== undefined && a.rangeSha !== rest.rangeSha) return false
        if (rest.binding !== undefined && a.binding !== rest.binding) return false
        if (rest.manifestSha !== undefined && a.manifestSha !== rest.manifestSha) return false
        return true
      })
      return filtered.sort((x, y) => y.attestation.createdAt.localeCompare(x.attestation.createdAt))
    },
    getAnnotations: readAnnotations,
    async updateAnnotations(key, update) {
      const path = annotationsPath(root, key)
      const prev = annotationLocks.get(path) ?? Promise.resolve()
      const next = prev.then(async () => {
        const updated = update(await readAnnotations(key))
        await writeJsonAtomic(path, updated)
        return updated
      })
      const settled = next.catch(() => undefined)
      annotationLocks.set(path, settled)
      void settled.then(() => {
        if (annotationLocks.get(path) === settled) annotationLocks.delete(path)
      })
      return next
    },
  }
}
