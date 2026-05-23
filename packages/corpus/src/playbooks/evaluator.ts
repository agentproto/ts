/**
 * PlaybookEvaluator — runs shadow vs baseline eval batches on AIP-12
 * playbooks, records winRateVsBaseline + sample size, decides
 * promotion readiness against `metadata.corpus.autoPromote`.
 *
 * Inputs (per eval-case the host hands us):
 *   - prompt: the test prompt
 *   - shadow.response: agent output WITH the playbook overlay applied
 *   - baseline.response: agent output WITHOUT the overlay
 *   - rubric: how to score both arms
 *
 * Output:
 *   - winRateVsBaseline = fraction of cases where shadow.score >= baseline.score
 *   - sampleSize = n
 *   - readyForActivation = winRate >= threshold && n >= minSampleSize
 *
 * The evaluator does NOT itself activate the playbook — it writes
 * shadowMetrics back to the PLAYBOOK.md (via the writer) and lets
 * the curator's `activate` workflow decide. That keeps the
 * audit chain clean: evaluator measures, curator decides.
 *
 * Pure logic. Backing IEvaluator + writer/emitter come in as ports.
 */

import matter from "gray-matter"
import type {
  EvalContextPort,
  EvalRubricPort,
  EvaluatorPort,
} from "../ports/evaluator.port.js"
import type { ClockPort } from "../ports/clock.port.js"
import type { FsPort } from "../ports/fs.port.js"
import type { IdentityPort } from "../ports/identity.port.js"
import { CorpusEventEmitter } from "../events/emitter.js"
import { CorpusWorkspaceReader } from "../workspace/reader.js"
import { CorpusWorkspaceWriter } from "../workspace/writer.js"
import {
  appendAttestation,
  makeAttestation,
} from "../lifecycle/attestations.js"
import { PlaybookNotFoundError } from "./lifecycle.js"
import { PlaybookRegistry } from "./registry.js"
import type { Playbook } from "./types.js"

export interface EvalCase {
  /** Optional stable id — used in event payloads + per-case audit. */
  readonly id?: string
  readonly prompt: string
  /** Agent output WITH the playbook overlay applied. */
  readonly shadowResponse: string
  /** Agent output WITHOUT the overlay (baseline). */
  readonly baselineResponse: string
}

export interface PlaybookBatchOptions {
  readonly rubric: EvalRubricPort
  readonly cases: readonly EvalCase[]
  /** Forwarded to evaluator + recorded in event payloads. */
  readonly contextOverrides?: Partial<EvalContextPort>
}

export interface PlaybookBatchResult {
  readonly playbookSlug: string
  readonly sampleSize: number
  readonly winRateVsBaseline: number
  readonly shadowAvgScore: number
  readonly baselineAvgScore: number
  readonly readyForActivation: boolean
  /** Per-case details — useful for the curator UI. */
  readonly perCase: readonly {
    readonly id?: string
    readonly shadowScore: number
    readonly baselineScore: number
    readonly winnerArm: "shadow" | "baseline" | "tie"
  }[]
}

export interface PlaybookEvaluatorOptions {
  readonly fs: FsPort
  readonly clock: ClockPort
  readonly identity: IdentityPort
  readonly workspacePath: string
  readonly evaluator: EvaluatorPort
}

export class PlaybookEvaluator {
  constructor(private readonly opts: PlaybookEvaluatorOptions) {}

  /**
   * Run an eval batch against a single playbook. For each case:
   *   1. Score shadow.response against rubric → shadowScore
   *   2. Score baseline.response against rubric → baselineScore
   *   3. shadow "wins" if shadowScore >= baselineScore
   * Aggregate: winRateVsBaseline = wins / n.
   *
   * On completion: writes shadowMetrics back to the PLAYBOOK.md (CAS),
   * emits a `corpus.playbook.evaluated` event (held outside the formal
   * AIP-41 taxonomy until the spec adopts it).
   */
  async runBatch(
    playbookSlug: string,
    batch: PlaybookBatchOptions
  ): Promise<PlaybookBatchResult> {
    const playbook = await this.loadPlaybook(playbookSlug)
    const perCase: PlaybookBatchResult["perCase"][number][] = []
    let wins = 0
    let shadowSum = 0
    let baselineSum = 0

    for (const c of batch.cases) {
      const shadowResult = await this.opts.evaluator.evaluate({
        rubric: batch.rubric,
        prompt: c.prompt,
        response: c.shadowResponse,
        context: {
          ...(batch.contextOverrides ?? {}),
          arm: "shadow",
          appliedPlaybooks: [playbookSlug],
        },
      })
      const baselineResult = await this.opts.evaluator.evaluate({
        rubric: batch.rubric,
        prompt: c.prompt,
        response: c.baselineResponse,
        context: {
          ...(batch.contextOverrides ?? {}),
          arm: "baseline",
          appliedPlaybooks: [],
        },
      })
      const winnerArm: "shadow" | "baseline" | "tie" =
        shadowResult.score > baselineResult.score
          ? "shadow"
          : shadowResult.score < baselineResult.score
            ? "baseline"
            : "tie"
      // Tie counts as a NON-win — playbook has to strictly beat baseline.
      if (winnerArm === "shadow") wins++
      shadowSum += shadowResult.score
      baselineSum += baselineResult.score
      perCase.push({
        id: c.id,
        shadowScore: shadowResult.score,
        baselineScore: baselineResult.score,
        winnerArm,
      })
    }

    const sampleSize = batch.cases.length
    const winRate = sampleSize > 0 ? wins / sampleSize : 0
    const auto = (playbook.corpus.autoPromote ?? {}) as {
      enabled?: boolean
      metric?: string
      threshold?: { gte?: number; lte?: number }
      minSampleSize?: number
    }
    const gteOK =
      typeof auto.threshold?.gte === "number"
        ? winRate >= auto.threshold.gte
        : false
    const sizeOK =
      typeof auto.minSampleSize === "number"
        ? sampleSize >= auto.minSampleSize
        : sampleSize > 0
    const readyForActivation = !!auto.enabled && gteOK && sizeOK

    // Persist shadowMetrics back to PLAYBOOK.md (CAS).
    await this.persistMetrics(playbook, {
      sampleSize,
      winRateVsBaseline: winRate,
      lastEvaluatedAt: this.opts.clock.now().toISOString(),
    })

    // Emit a custom event — the formal AIP-41 event taxonomy doesn't
    // yet include a typed name like `playbook.shadow.evaluated`, so we
    // route through the lower-level CorpusWorkspaceWriter / FsPort
    // directly here. The host can tail _log.md and pick this up.
    // (Same `_log.md` format as the standard emitter.)
    await this.appendCustomEvent("playbook.shadow.evaluated", {
      slug: playbook.slug,
      sampleSize,
      winRateVsBaseline: winRate,
      readyForActivation,
    })

    return Object.freeze({
      playbookSlug: playbook.slug,
      sampleSize,
      winRateVsBaseline: winRate,
      shadowAvgScore: sampleSize > 0 ? shadowSum / sampleSize : 0,
      baselineAvgScore: sampleSize > 0 ? baselineSum / sampleSize : 0,
      readyForActivation,
      perCase: Object.freeze(perCase),
    })
  }

  // ── Internal ─────────────────────────────────────────────────────

  private async loadPlaybook(slug: string): Promise<Playbook> {
    const reader = new CorpusWorkspaceReader({ fs: this.opts.fs })
    const snapshot = await reader.read(this.opts.workspacePath)
    const reg = new PlaybookRegistry({ snapshot })
    const p = reg.bySlugOrNull(slug)
    if (!p) throw new PlaybookNotFoundError(slug)
    return p
  }

  private async persistMetrics(
    playbook: Playbook,
    metrics: {
      sampleSize: number
      winRateVsBaseline: number
      lastEvaluatedAt: string
    }
  ): Promise<void> {
    const writer = new CorpusWorkspaceWriter({ fs: this.opts.fs })
    const identity = await this.opts.identity.resolve()
    let fm = { ...playbook.file.frontmatter } as Record<string, unknown>
    const metaIn = (fm.metadata as Record<string, unknown> | undefined) ?? {}
    const corpusIn =
      (metaIn.corpus as Record<string, unknown> | undefined) ?? {}
    fm.metadata = {
      ...metaIn,
      corpus: {
        ...corpusIn,
        shadowMetrics: metrics,
      },
    }
    // Append the `evaluated` attestation so the chain records who/when.
    fm = appendAttestation(
      fm,
      makeAttestation({
        kind: "evaluated",
        identity: identity.principal,
        at: metrics.lastEvaluatedAt,
        note: `n=${metrics.sampleSize} winRate=${metrics.winRateVsBaseline.toFixed(3)}`,
      })
    )
    const content = matter.stringify(
      playbook.body.startsWith("\n") ? playbook.body : "\n" + playbook.body,
      fm
    )
    await writer.writeFile(
      joinPath(this.opts.workspacePath, playbook.path),
      content,
      playbook.versionToken
    )
  }

  private async appendCustomEvent(
    customKind: string,
    payload: Readonly<Record<string, unknown>>
  ): Promise<void> {
    // Use the canonical emitter shape so _log.md stays homogeneous,
    // but pass through the kit's typed CorpusEventEmitter for the
    // formal kinds. For custom kinds, we hand-craft a line so the
    // file format stays one-event-per-line.
    const identity = await this.opts.identity.resolve()
    const line = `- ${this.opts.clock.now().toISOString()}  ${customKind}  by ${identity.principal}  payload=${JSON.stringify(payload, [...Object.keys(payload).sort()])}\n`
    const logPath = joinPath(this.opts.workspacePath, "_log.md")
    // Initialize the log file with the AIP-10 header on first write
    // (same shape as CorpusEventEmitter).
    if (!(await this.opts.fs.exists(logPath))) {
      // Construct a fresh emitter to write the header for parity.
      const emitter = new CorpusEventEmitter({
        fs: this.opts.fs,
        clock: this.opts.clock,
        identity: this.opts.identity,
        workspaceRoot: this.opts.workspacePath,
      })
      // Cheapest way to materialize the header: emit one canonical
      // event (the host might prefer to just call `appendFile`
      // directly; keeping the header parity is the important bit).
      void emitter
      await this.opts.fs.writeFile(
        logPath,
        "# Corpus activity log\n\nAppend-only AIP-10 log of corpus state transitions. Each line:\n`- <iso>  <kind>  by <actor>  payload=<json>`\n\n"
      )
    }
    await this.opts.fs.appendFile(logPath, line)
  }
}

function joinPath(a: string, b: string): string {
  if (!a) return b
  return a.endsWith("/") ? a + b : a + "/" + b
}
