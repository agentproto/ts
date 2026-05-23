/**
 * PlaybookLifecycle — activate / archive / supersede AIP-12
 * playbooks, atomically.
 *
 * State machine (per the AIP-12 spec):
 *   shadow   → active | archived
 *   active   → archived
 *   archived = terminal
 *
 * activate(slug):
 *   1. Read current playbook (CAS via versionToken).
 *   2. For each slug in playbook.supersedes that's currently active:
 *      transition that slug to `archived` first.
 *   3. Update the target playbook's status → "active", clear
 *      shadowMetrics.lastEvaluatedAt to mark the activation moment.
 *   4. Atomic file write (CAS).
 *   5. Emit `playbook.activated` event.
 *
 * archive(slug, reason):
 *   1. CAS read.
 *   2. Set status → "archived", metadata.corpus.archiveReason = reason.
 *   3. Atomic write.
 *   4. Emit `playbook.archived`.
 *
 * Multi-file transaction guarded by FsPort.lock so a concurrent
 * activate can't half-supersede.
 */

import matter from "gray-matter"
import type { ClockPort } from "../ports/clock.port.js"
import type { FsPort } from "../ports/fs.port.js"
import type { IdentityPort } from "../ports/identity.port.js"
import { CorpusEventEmitter } from "../events/emitter.js"
import { CorpusWorkspaceReader } from "../workspace/reader.js"
import { CorpusWorkspaceWriter } from "../workspace/writer.js"
import { appendAttestation, makeAttestation } from "../lifecycle/attestations.js"
import type { Attestation } from "../types.js"
import { PlaybookRegistry } from "./registry.js"
import type { Playbook, PlaybookStatus } from "./types.js"

export class PlaybookNotFoundError extends Error {
  constructor(readonly slug: string) {
    super(`PlaybookNotFoundError: no playbook found with slug "${slug}"`)
    this.name = "PlaybookNotFoundError"
  }
}

export class IllegalPlaybookTransitionError extends Error {
  constructor(
    readonly slug: string,
    readonly from: PlaybookStatus,
    readonly to: PlaybookStatus
  ) {
    super(
      `IllegalPlaybookTransitionError: ${slug}: ${from} → ${to} is not allowed`
    )
    this.name = "IllegalPlaybookTransitionError"
  }
}

export interface PlaybookLifecycleOptions {
  readonly fs: FsPort
  readonly clock: ClockPort
  readonly identity: IdentityPort
  readonly workspacePath: string
}

export interface ActivateResult {
  readonly slug: string
  readonly previousStatus: PlaybookStatus
  readonly versionToken: string
  readonly supersededSlugs: readonly string[]
}

export interface ArchiveResult {
  readonly slug: string
  readonly previousStatus: PlaybookStatus
  readonly versionToken: string
}

export class PlaybookLifecycle {
  constructor(private readonly opts: PlaybookLifecycleOptions) {}

  /**
   * Transition `slug` from shadow → active. Cascades through
   * `supersedes[]`: any currently-active playbook listed there is
   * archived (with `archiveReason: superseded-by-<slug>`) in the
   * same lock-guarded transaction.
   */
  async activate(slug: string): Promise<ActivateResult> {
    const writer = new CorpusWorkspaceWriter({ fs: this.opts.fs })
    const lockPath = joinPath(this.opts.workspacePath, "_log.md")
    return await writer.transaction(lockPath, async () => {
      const playbook = await this.loadOne(slug)
      assertTransition(playbook.status, "active", slug)

      // Supersede chain: archive previous active versions BEFORE
      // we flip this one. If any supersede write fails, the lock
      // protects us from a half-activated state — but the AIP-10
      // log will show the partial sequence so a recovery routine
      // can detect inconsistency.
      const supersededSlugs: string[] = []
      const reg = await this.loadRegistry()
      const identity = await this.opts.identity.resolve()
      for (const supersededSlug of playbook.supersedes) {
        const prev = reg.bySlugOrNull(supersededSlug)
        if (!prev || prev.status !== "active") continue
        const att = this.attestation(
          "archived",
          identity.principal,
          `superseded-by-${slug}`
        )
        await this.writeWith(prev, (fm) =>
          appendAttestation(
            patchStatus(fm, "archived", {
              archiveReason: `superseded-by-${slug}`,
              archivedAt: att.at,
            }),
            att
          )
        )
        await this.emitter().emit("playbook.archived", {
          slug: prev.slug,
          archiveReason: `superseded-by-${slug}`,
        })
        supersededSlugs.push(prev.slug)
      }

      const activateAtt = this.attestation(
        "activated",
        identity.principal,
        `from=${playbook.status}`
      )
      const newToken = await this.writeWith(playbook, (fm) =>
        appendAttestation(
          patchStatus(fm, "active", { activatedAt: activateAtt.at }),
          activateAtt
        )
      )
      await this.emitter().emit("playbook.activated", {
        slug,
        previousStatus: playbook.status,
        supersededSlugs,
      })

      return {
        slug,
        previousStatus: playbook.status,
        versionToken: newToken,
        supersededSlugs: Object.freeze(supersededSlugs),
      }
    })
  }

  /**
   * Transition `slug` → archived. Skip-no-op if already archived.
   */
  async archive(slug: string, reason: string): Promise<ArchiveResult> {
    const writer = new CorpusWorkspaceWriter({ fs: this.opts.fs })
    const lockPath = joinPath(this.opts.workspacePath, "_log.md")
    return await writer.transaction(lockPath, async () => {
      const playbook = await this.loadOne(slug)
      if (playbook.status === "archived") {
        return {
          slug,
          previousStatus: "archived" as const,
          versionToken: playbook.versionToken,
        }
      }
      assertTransition(playbook.status, "archived", slug)
      const identity = await this.opts.identity.resolve()
      const att = this.attestation("archived", identity.principal, reason)
      const newToken = await this.writeWith(playbook, (fm) =>
        appendAttestation(
          patchStatus(fm, "archived", {
            archiveReason: reason,
            archivedAt: att.at,
          }),
          att
        )
      )
      await this.emitter().emit("playbook.archived", {
        slug,
        previousStatus: playbook.status,
        archiveReason: reason,
      })
      return {
        slug,
        previousStatus: playbook.status,
        versionToken: newToken,
      }
    })
  }

  // ── Internal ─────────────────────────────────────────────────────

  private async loadOne(slug: string): Promise<Playbook> {
    const reg = await this.loadRegistry()
    const p = reg.bySlugOrNull(slug)
    if (!p) throw new PlaybookNotFoundError(slug)
    return p
  }

  private async loadRegistry(): Promise<PlaybookRegistry> {
    const reader = new CorpusWorkspaceReader({ fs: this.opts.fs })
    const snapshot = await reader.read(this.opts.workspacePath)
    return new PlaybookRegistry({ snapshot })
  }

  private async writeWith(
    playbook: Playbook,
    patch: (fm: Record<string, unknown>) => Record<string, unknown>
  ): Promise<string> {
    const writer = new CorpusWorkspaceWriter({ fs: this.opts.fs })
    // Rebuild the file content from the parsed frontmatter +
    // original body. We use the parsed-frontmatter shape (not the
    // raw original .md) so the patch is applied to typed data.
    const nextFm = patch({ ...playbook.file.frontmatter })
    const nextContent = matter.stringify(
      playbook.body.startsWith("\n") ? playbook.body : "\n" + playbook.body,
      nextFm
    )
    return await writer.writeFile(
      joinPath(this.opts.workspacePath, playbook.path),
      nextContent,
      playbook.versionToken
    )
  }

  /** Build a transition attestation from current clock + given identity. */
  private attestation(
    kind: Attestation["kind"],
    identity: string,
    note?: string
  ): Attestation {
    return makeAttestation({
      kind,
      identity,
      at: this.opts.clock.now().toISOString(),
      ...(note ? { note } : {}),
    })
  }

  private emitter(): CorpusEventEmitter {
    return new CorpusEventEmitter({
      fs: this.opts.fs,
      clock: this.opts.clock,
      identity: this.opts.identity,
      workspaceRoot: this.opts.workspacePath,
    })
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function assertTransition(
  from: PlaybookStatus,
  to: PlaybookStatus,
  slug: string
): void {
  const allowed: Record<PlaybookStatus, readonly PlaybookStatus[]> = {
    shadow: ["active", "archived"],
    active: ["archived"],
    archived: [],
  }
  if (!allowed[from].includes(to)) {
    throw new IllegalPlaybookTransitionError(slug, from, to)
  }
}

function patchStatus(
  fm: Record<string, unknown>,
  newStatus: PlaybookStatus,
  extraCorpusMeta: Record<string, unknown>
): Record<string, unknown> {
  const metaIn = (fm.metadata as Record<string, unknown> | undefined) ?? {}
  const corpusIn =
    (metaIn.corpus as Record<string, unknown> | undefined) ?? {}
  return {
    ...fm,
    status: newStatus,
    metadata: {
      ...metaIn,
      corpus: {
        ...corpusIn,
        ...extraCorpusMeta,
      },
    },
  }
}

function joinPath(a: string, b: string): string {
  if (!a) return b
  return a.endsWith("/") ? a + b : a + "/" + b
}
