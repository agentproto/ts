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
 * Same persistence primitives as the sibling JSON stores (`node:fs/promises`,
 * write-tmp + rename). The root is injectable so tests never touch
 * `~/.agentproto`.
 */

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { ledgerKeyOf, type Attestation, type LedgerKey, type RubricDigest } from "@agentproto/review"

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

export interface ReviewLedgerFilter {
  repoRemote?: string
  rangeSha?: string
  binding?: string
  manifestSha?: string
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
}

export const defaultReviewLedgerRoot = (): string => join(homedir(), ".agentproto", "reviews")

/** Filesystem-safe slug of a normalized repo remote
 *  (`github.com/agentproto/ts` → `github.com_agentproto_ts`). */
export function repoSlug(repoRemote: string): string {
  return repoRemote.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "repo"
}

function keyPath(root: string, key: LedgerKey): string {
  return join(root, repoSlug(key.repoRemote), key.manifestSha, key.binding, `${key.rangeSha}.json`)
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
    return ents.filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => join(dir, e.name))
  } catch {
    return []
  }
}

export function createReviewLedger(opts: { root?: string } = {}): ReviewLedger {
  const root = opts.root ?? defaultReviewLedgerRoot()

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
      await mkdir(join(path, ".."), { recursive: true })
      const tmp = `${path}.tmp.${process.pid}`
      await writeFile(tmp, `${JSON.stringify(entry, null, 2)}\n`, "utf8")
      await rename(tmp, path)
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
      return scan(filter)
    },
  }
}
