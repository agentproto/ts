/**
 * captureFootprint — drain a SocialSourcePort into a buffered array.
 *
 * The footprint is consumed once and fanned out to both sinks (corpus +
 * graph), so the orchestrator buffers it here. Bounded by design: a single
 * person's footprint is hundreds–low-thousands of records. For very large
 * accounts, cap per-slice depth via CaptureOptions.limit.
 */

import type { FootprintRecord } from "./model/footprint.js"
import type { SocialSourcePort, CaptureOptions } from "./ports/social-source.port.js"

export interface CaptureResult {
  readonly records: FootprintRecord[]
  /** The subject's profile card, if the adapter yielded one. */
  readonly profile?: Extract<FootprintRecord, { kind: "profile" }>
}

export async function captureFootprint(
  port: SocialSourcePort,
  handle: string,
  opts: CaptureOptions
): Promise<CaptureResult> {
  const records: FootprintRecord[] = []
  let profile: CaptureResult["profile"]
  for await (const record of port.capture(handle, opts)) {
    if (record.kind === "profile" && !profile) profile = record
    records.push(record)
  }
  return { records, profile }
}
