/**
 * Promote workflow — turn an analyzed candidate into a published
 * AIP-10 entry. The fan-out the plan describes:
 *
 *   1. Validate the promotion request (gate check, slug uniqueness)
 *   2. Acquire workspace lock (atomicity across the multi-file write)
 *   3. Write the entry file (AIP-10 conformant frontmatter + body)
 *   4. Update _index.md (faceted catalog regen)
 *   5. Sync to backing engine via CorpusIndexer
 *   6. Append corpus.entry.promoted event to _log.md
 *   7. Take the candidate row out of the sidecar (or update the
 *      AIP-18 ITEM.md if it was materialized already)
 *
 * Idempotent on candidate.id — re-running promote for the same id
 * reuses the existing entry path rather than duplicating. The
 * workspace lock guards against concurrent promoters.
 *
 * Pure-ish: the workflow itself is logic + orchestration; every I/O
 * effect goes through the injected reader/writer/emitter/indexer.
 */

import type { CorpusWorkspaceSnapshot } from "../types.js"
import type { ClockPort } from "../ports/clock.port.js"
import type { FsPort } from "../ports/fs.port.js"
import { CorpusWorkspaceReader } from "../workspace/reader.js"
import {
  CorpusWorkspaceWriter,
  type MarkdownDoc,
} from "../workspace/writer.js"
import { CorpusEventEmitter } from "../events/emitter.js"
import { CorpusIndexer } from "../index/indexer.js"
import { evaluateGate, extractAutoPromoteConfig } from "./gate.js"
import { appendAttestation, makeAttestation } from "./attestations.js"
import type { IdentityPort } from "../ports/identity.port.js"

export interface PromoteOptions {
  /** Workspace root inside FsPort (typically ""). */
  readonly workspacePath: string
  /** Slug of the entry to create (or update, if it already exists). */
  readonly entrySlug: string
  /** AIP-10 entry kind (principle | pattern | …). */
  readonly entryKind: string
  /** Path of the entry within the workspace, e.g. entries/patterns/2026/foo.md */
  readonly entryPath: string
  /** AIP-10 entry frontmatter to publish. */
  readonly frontmatter: Readonly<Record<string, unknown>>
  /** Entry body (markdown after frontmatter). */
  readonly body: string
  /**
   * Optional candidate id to consume from a sidecar. When provided,
   * the workflow removes the row from `collections/<name>/_candidates.yaml`
   * on success (caller specifies the collection via `candidateSidecar`).
   */
  readonly candidateId?: string
  readonly candidateSidecarPath?: string
  /**
   * Bypass the auto-promote gate. Used when a curator manually
   * approves a candidate that failed the gate (corpus-review path).
   * The emitted event still records the bypass.
   */
  readonly bypassGate?: boolean
}

export interface PromoteResult {
  readonly entryPath: string
  readonly entryVersionToken: string
  readonly chunkCount: number
  readonly gatePassed: boolean
  readonly bypassed: boolean
}

export interface PromoteContext {
  readonly fs: FsPort
  readonly clock: ClockPort
  readonly identity: IdentityPort
  readonly indexer: CorpusIndexer
}

export class PromoteRejectedError extends Error {
  constructor(
    readonly entrySlug: string,
    readonly failures: ReadonlyArray<{ rule: string; message: string }>
  ) {
    super(
      `PromoteRejectedError: ${entrySlug} failed auto-promote gate — ${failures
        .map((f) => `[${f.rule}] ${f.message}`)
        .join(" / ")}`
    )
    this.name = "PromoteRejectedError"
  }
}

/**
 * Workspace-scoped promoter. Construct once per workspace + per
 * actor (identity is captured by the injected IdentityPort).
 */
export class CorpusPromoter {
  constructor(private readonly ctx: PromoteContext) {}

  async promote(opts: PromoteOptions): Promise<PromoteResult> {
    const reader = new CorpusWorkspaceReader({ fs: this.ctx.fs })
    const writer = new CorpusWorkspaceWriter({ fs: this.ctx.fs })
    const emitter = new CorpusEventEmitter({
      fs: this.ctx.fs,
      clock: this.ctx.clock,
      identity: this.ctx.identity,
      workspaceRoot: opts.workspacePath,
    })

    // Acquire workspace transaction lock (multi-file write).
    const lockPath = joinPath(opts.workspacePath, "_log.md")
    return await writer.transaction(lockPath, async () => {
      const snapshot = await reader.read(opts.workspacePath)

      // Gate check unless explicitly bypassed.
      let gatePassed = false
      let bypassed = false
      if (opts.bypassGate) {
        bypassed = true
      } else {
        const config = extractAutoPromoteConfig(snapshot)
        const result = evaluateGate(
          {
            frontmatter: opts.frontmatter,
            body: opts.body,
          },
          config
        )
        gatePassed = result.passed
        if (!result.passed && !result.disabled) {
          throw new PromoteRejectedError(opts.entrySlug, result.failures)
        }
        // If auto-promote is disabled, treat as bypassed (caller is in
        // charge of routing through corpus-review).
        if (result.disabled) bypassed = true
      }

      // Resolve existing entry vs new. Idempotency on candidate.id:
      // if the same slug already exists, we overwrite (re-promotion
      // path); if a different slug at this path exists, that's a bug.
      const existing = snapshot.entries.find(
        (e) => e.frontmatter.slug === opts.entrySlug
      )
      const targetPath = existing?.path ?? opts.entryPath
      const expectedToken = existing?.versionToken ?? null

      // Append a `promoted` attestation before writing. The chain is
      // append-only — readers get the full history of who promoted
      // when, what gate state, whether bypassed.
      const identity = await this.ctx.identity.resolve()
      const attestedFm = appendAttestation(
        opts.frontmatter,
        makeAttestation({
          kind: "promoted",
          identity: identity.principal,
          at: this.ctx.clock.now().toISOString(),
          note: bypassed
            ? `bypassed=true${gatePassed ? "" : " (gate not consulted)"}`
            : `gatePassed=${gatePassed}`,
        })
      )

      // Write entry atomically (CAS for re-promotion).
      const doc: MarkdownDoc = {
        frontmatter: attestedFm,
        body: opts.body,
      }
      const entryAbsPath = joinPath(opts.workspacePath, targetPath)
      const entryVersionToken = await writer.writeMarkdown(
        entryAbsPath,
        doc,
        expectedToken
      )

      // Re-snapshot so the indexer sees the freshly-written entry.
      const freshSnapshot = await reader.read(opts.workspacePath)
      const indexResult = await this.ctx.indexer.syncEntry(
        freshSnapshot,
        opts.entrySlug
      )

      // Regenerate _index.md (host-maintained faceted catalog).
      await regenIndexFile({
        fs: this.ctx.fs,
        workspacePath: opts.workspacePath,
        snapshot: freshSnapshot,
        clock: this.ctx.clock,
      })

      // Consume the sidecar row, if any.
      if (opts.candidateId && opts.candidateSidecarPath) {
        const { CandidatesSidecar } = await import("../workspace/sidecar.js")
        const sidecar = new CandidatesSidecar({
          fs: this.ctx.fs,
          path: joinPath(opts.workspacePath, opts.candidateSidecarPath),
        })
        // Tolerate already-removed rows (re-promotion path).
        try {
          await sidecar.take(opts.candidateId)
        } catch {
          // not-found means it was already taken
        }
      }

      // Append the audit event.
      await emitter.emit("corpus.entry.promoted", {
        slug: opts.entrySlug,
        kind: opts.entryKind,
        entryPath: targetPath,
        candidateId: opts.candidateId,
        bypassed,
        gatePassed,
        chunkCount: indexResult.chunkCount,
      })

      return {
        entryPath: targetPath,
        entryVersionToken,
        chunkCount: indexResult.chunkCount,
        gatePassed,
        bypassed,
      }
    })
  }
}

// ── _index.md regeneration ─────────────────────────────────────────

interface RegenInput {
  readonly fs: FsPort
  readonly workspacePath: string
  readonly snapshot: CorpusWorkspaceSnapshot
  readonly clock: ClockPort
}

/**
 * Generate a minimal faceted catalog: entries grouped by kind, with
 * quality + recency hints. Richer regen (additional facets, retrieval
 * boost panel) can layer on later; this version is enough to prove
 * the regen runs on every promotion.
 */
async function regenIndexFile(input: RegenInput): Promise<void> {
  const lines: string[] = []
  lines.push("# Corpus index")
  lines.push("")
  lines.push(
    `Generated ${input.clock.now().toISOString()} — ${input.snapshot.entries.length} entries.`
  )
  lines.push("")

  // Group entries by kind for the at-a-glance facet.
  type Entry = (typeof input.snapshot.entries)[number]
  const byKind = new Map<string, Entry[]>()
  for (const entry of input.snapshot.entries) {
    const k = String(entry.frontmatter.kind ?? "unknown")
    const bucket = byKind.get(k) ?? []
    bucket.push(entry)
    byKind.set(k, bucket)
  }

  for (const [kind, entries] of [...byKind].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    lines.push(`## ${kind} (${entries.length})`)
    lines.push("")
    for (const e of entries.sort((a: Entry, b: Entry) =>
      String(a.frontmatter.slug).localeCompare(String(b.frontmatter.slug))
    )) {
      const slug = e.frontmatter.slug
      const title = e.frontmatter.title ?? slug
      const corpus = (e.frontmatter.metadata as { corpus?: { qualityScore?: number; status?: string } })
        ?.corpus
      const q = corpus?.qualityScore
      const s = corpus?.status ?? "active"
      const meta: string[] = []
      if (s !== "active") meta.push(`status=${s}`)
      if (typeof q === "number") meta.push(`q=${q.toFixed(1)}`)
      const suffix = meta.length > 0 ? `  _(${meta.join(", ")})_` : ""
      lines.push(`- [[${slug}]] — ${title}${suffix}`)
    }
    lines.push("")
  }

  const content = lines.join("\n")
  await input.fs.writeFile(
    joinPath(input.workspacePath, "_index.md"),
    content
  )
}

function joinPath(a: string, b: string): string {
  if (!a) return b
  return a.endsWith("/") ? a + b : a + "/" + b
}
