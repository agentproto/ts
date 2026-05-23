/**
 * Reviewer track record — per-reviewer history of (score → observed
 * outcome) used to compute calibration weights.
 *
 * Stored at `corpus/_calibration/reviewer-track-record.yaml`:
 *
 *   reviewers:
 *     "ws://operators/quality-reviewer":
 *       - { entrySlug, qualityScore, observedUtility?, observedLift?, at }
 *     "ws://operators/junior-reviewer":
 *       - ...
 *
 * Append-only — every review pass adds rows. The calibration routine
 * reads the configured window (typically 90 days), correlates the
 * reviewer's scores against observed retrieval-quality outcomes, and
 * derives a weight in [0, 1] that feeds the multi-reviewer aggregator
 * (see `aggregate.ts`).
 */

import { parse as yamlParse, stringify as yamlStringify } from "yaml"
import type { FsPort } from "../ports/fs.port.js"

export interface TrackRecordEntry {
  readonly entrySlug: string
  /** Reviewer-assigned 0..5 quality score at review time. */
  readonly qualityScore: number
  /** Retrieval utility (0..1 — fraction of hits actually cited). */
  readonly observedUtility?: number
  /** Retrieval lift (>1 = boost vs baseline, <1 = drag). */
  readonly observedLift?: number
  readonly at: string
}

interface TrackRecordShape {
  reviewers: Record<string, readonly TrackRecordEntry[]>
}

const DEFAULT_PATH = "_calibration/reviewer-track-record.yaml"

export interface ReviewerTrackRecordOptions {
  readonly fs: FsPort
  /** Workspace-relative path. Defaults to `_calibration/reviewer-track-record.yaml`. */
  readonly path?: string
}

export class ReviewerTrackRecord {
  private readonly path: string

  constructor(private readonly opts: ReviewerTrackRecordOptions) {
    this.path = opts.path ?? DEFAULT_PATH
  }

  /** Load the full record. Empty when the file doesn't exist yet. */
  async load(): Promise<Readonly<Record<string, readonly TrackRecordEntry[]>>> {
    if (!(await this.opts.fs.exists(this.path))) return {}
    const content = await this.opts.fs.readFile(this.path)
    if (!content.trim()) return {}
    const parsed = yamlParse(content) as Partial<TrackRecordShape> | null
    if (!parsed || typeof parsed.reviewers !== "object") return {}
    return Object.freeze(parsed.reviewers as Record<string, readonly TrackRecordEntry[]>)
  }

  /** Append one entry under a reviewer's identity. */
  async append(
    reviewerIdentity: string,
    entry: TrackRecordEntry
  ): Promise<void> {
    const existing = await this.load()
    const current = existing[reviewerIdentity] ?? []
    const next: TrackRecordShape = {
      reviewers: {
        ...existing,
        [reviewerIdentity]: [...current, entry],
      },
    }
    const content = yamlStringify(next)
    await this.opts.fs.writeFile(this.path, content)
  }

  /**
   * Read all entries for a reviewer in the last N days. Used by the
   * calibration routine to compute correlation on a rolling window.
   */
  async window(
    reviewerIdentity: string,
    days: number,
    now: Date
  ): Promise<readonly TrackRecordEntry[]> {
    const all = await this.load()
    const slice = all[reviewerIdentity] ?? []
    const cutoffMs = now.getTime() - days * 86_400_000
    return slice.filter((e) => Date.parse(e.at) >= cutoffMs)
  }

  /** Reviewer identities present in the record. */
  async listReviewers(): Promise<readonly string[]> {
    const all = await this.load()
    return Object.keys(all)
  }
}
