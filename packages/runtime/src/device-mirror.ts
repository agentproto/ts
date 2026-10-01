/**
 * BOOTSTRAP P7b — read-time mirror of a HOST device's turns into the
 * CONTROLLER's own session reads (issue #1637).
 *
 * A `session spawned with sandbox: "device:<fp|name>"` lives on TWO
 * daemons: the controller keeps a thin proxy-backed descriptor (its `id`,
 * e.g. `sess_305be17c`) while the real conversation accumulates on the
 * host' under a DIFFERENT id (`sess_cf318f00`, on the descriptor's
 * `hostSessionId`). #1640 gave the controller WRITE access across the gap
 * (`device_prompt`); this module closes the READ half: nothing runs in
 * the background — every controller READ (`GET /sessions/:id`, the
 * `/output` tail, `/events`, `/export`, the `agent_output` tool) calls
 * {@link syncDeviceMirror} first, which:
 *
 *   1. derives the dedup cursor from the session's OWN events.jsonl (max
 *      `hostSeq` across records tagged `origin: "device"` — so the cursor
 *      survives a daemon restart by construction, P7b-3), seeding it the
 *      first time from what the controller already knows locally (below),
 *   2. dials the host ONCE over the existing E2E channel
 *      (`HostRegistry.forwardHttp`, the same path `device_sessions` uses)
 *      and pages `GET /sessions/:hostSessionId/events?since=<cursor>` —
 *      an EXISTING host route; no host-side changes are consumed for this
 *      (P7b uses today's 1.7.x-compatible endpoints only),
 *   3. appends the new host records to the controller transcript,
 *      byte-faithful, tagged `origin: "device"` + `hostSeq` +
 *      `sourceRef: "device:<fp>"` (idempotent by the hostSeq cursor —
 *      re-reading never duplicates), and
 *   4. cheaply refreshes the controller descriptor's live projection
 *      fields from the host snapshot (`lastActivityAt`, `busy`, usage),
 *      without touching controller-local fields (label, agentsMdMode…).
 *
 * Backward compatibility (P7b constraint): only EXISTING host endpoints
 * are consumed. An older host, or one whose daemon lacks the events route,
 * surfaces as `mirrorError` on the descriptor — never a crash, never a
 * silent stale overwrite.
 */

import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import type { HostRegistry } from "./host-registry.js"
import type { SessionDescriptor } from "./sessions.js"
import { sessionEventsPath } from "./transcript-writer.js"

/** The origin tag every mirrored record carries — also the filter the
 *  cursor derivation keys on: a record WITHOUT it is controller-local, one
 *  WITH it was merged from the host. */
export const DEVICE_ORIGIN = "device"

/** Per-page cap — `GET /sessions/:id/events`'s own max `limit`. */
const PAGE_LIMIT = 2000
/** Safety cap on pages per sync — a pathological transcript keeps tripping
 *  the incremental `complete` flag round after round until this gives up;
 *  nothing lost, the next read continues from the advanced cursor. */
const MAX_PAGES = 4

/** One raw record off the host's own transcript (the exact on-disk shape —
 *  `{seq, ts, kind, ...}` — so the mirror is byte-faithful to the host). */
export type HostEventRecord = Record<string, unknown>

/**
 * Dial the host and read its session's transcript from `sinceSeq`
 * (exclusive), paginating until the host reports the tail complete.
 *
 * Same failure semantics as `device_sessions`' tail mode, but WITHOUT its
 * stale-snapshot fallback: the host's unreachability must surface as
 * `{ ok: false, error }` so readers can show "host unreachable" rather
 * than silently rendering the last snapshot (P7b-1). `404 no_transcript`
 * (a host session with nothing written — most usefully a just-spawned one)
 * is a NORMAL empty result, not an error.
 */
export type FetchHostTurnsResult =
  | {
      ok: true
      /** Records strictly AFTER `sinceSeq`, ascending. */
      events: HostEventRecord[]
      /** Host-reported tip: the seq the next call should use as `sinceSeq`. */
      nextSeq: number
    }
  | { ok: false; error: string; staleAt?: string }

export async function fetchHostTurns(
  hosts: HostRegistry,
  hostFingerprint: string,
  hostSessionId: string,
  sinceSeq: number,
): Promise<FetchHostTurnsResult> {
  const events: HostEventRecord[] = []
  let cursor = sinceSeq
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await hosts.forwardHttp(hostFingerprint, {
        method: "GET",
        path: `/sessions/${encodeURIComponent(hostSessionId)}/events?since=${cursor}&limit=${PAGE_LIMIT}`,
      })
      if (res.stale) {
        return {
          ok: false,
          error: `host unreachable — serving nothing rather than the stale snapshot from ${res.capturedAt}`,
          staleAt: res.capturedAt,
        }
      }
      if (res.status === 404) {
        // Either "no such host session" or "no events file yet" — both read
        // as an empty mirror, not a failure: a just-spawned host turn has
        // produced no transcript rows yet.
        return { ok: true, events, nextSeq: cursor }
      }
      if (res.status < 200 || res.status >= 300) {
        return {
          ok: false,
          error: `host GET /sessions/${hostSessionId}/events returned ${res.status}: ${Buffer.from(res.body)
            .toString("utf8")
            .slice(0, 300)}`,
        }
      }
      let parsed: { events?: unknown; nextSeq?: unknown; complete?: unknown } = {}
      try {
        const body: unknown = JSON.parse(Buffer.from(res.body).toString("utf8"))
        if (body !== null && typeof body === "object") {
          parsed = body as typeof parsed
        }
      } catch {
        return { ok: false, error: "host returned a non-JSON events page" }
      }
      if (!Array.isArray(parsed.events)) {
        return { ok: false, error: "host events page is not an events array" }
      }
      let lastSeq = cursor
      for (const record of parsed.events) {
        if (record !== null && typeof record === "object") {
          const seq = (record as { seq?: unknown })["seq"]
          if (typeof seq === "number" && Number.isFinite(seq) && seq > lastSeq) lastSeq = seq
          events.push(record as HostEventRecord)
        }
      }
      cursor = lastSeq
      if (parsed.complete !== false) break
      if (events.length > 0 && lastSeq <= sinceSeq && cursor <= sinceSeq) break
    }
    return { ok: true, events, nextSeq: cursor }
  } catch (err) {
    return {
      ok: false,
      error: `host dial failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/* ── cursor + seed (P7b-3: idempotence) ──────────────────────────── */

/** One parseable line of a controller events.jsonl. */
async function* readEventRecords(path: string): AsyncGenerator<Record<string, unknown>> {
  let stream: ReturnType<typeof createReadStream>
  try {
    stream = createReadStream(path, { encoding: "utf8" })
    await new Promise<void>((resolve, reject) => {
      stream.once("error", reject)
      stream.once("open", resolve)
    })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return
    return // unreadable transcript → treat as empty, never fail a read
  }
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const rec = JSON.parse(trimmed) as Record<string, unknown>
      yield rec
    } catch {
      // tolerate malformed/torn lines, same as every other transcript reader
    }
  }
}

/** The highest `hostSeq` already mirrored into the session's transcript —
 *  the next sync reads only what is STRICTLY newer, so a daemon restart or
 *  a re-read can never duplicate or skip turns (P7b-3, the correctness
 *  core). Scans for `origin === "device"` records; every other line is
 *  controller-local and owns no `hostSeq`. Standalone fs reader (tests +
 *  tooling): the LIVE sync path uses the registry's own
 *  `scanDeviceMirrorState` so custom transcript base dirs can't drift. */
export async function mirrorCursorForSession(sessionId: string, baseDir?: string): Promise<number> {
  let max = 0
  for await (const rec of readEventRecords(sessionEventsPath(sessionId, baseDir))) {
    if (rec["origin"] !== DEVICE_ORIGIN) continue
    const hostSeq = rec["hostSeq"]
    if (typeof hostSeq === "number" && Number.isFinite(hostSeq) && hostSeq > max) max = hostSeq
  }
  return max
}

/** The (ordered) user-prompt texts the controller already knows locally —
 *  the seed walk (below) matches them against the host transcript's own
 *  first turns so content the controller captured live through the sandbox
 *  proxy (the spawn turn, any `agent_prompt`-driven turns) is not re-merged
 *  as device-tagged duplicates. */
async function localUserPromptTexts(sessionId: string): Promise<string[]> {
  const texts: string[] = []
  for await (const rec of readEventRecords(sessionEventsPath(sessionId))) {
    if (rec["kind"] !== "user-prompt") continue
    if (rec["origin"] === DEVICE_ORIGIN) continue
    const text = rec["text"]
    if (typeof text === "string" && text.length > 0) texts.push(text)
  }
  return texts
}

/**
 * Seed the cursor so a FIRST mirror read (before anything was ever
 * mirrored) skips the turns the controller already recorded on its own.
 *
 * Walks the host transcript in order; a host `user-prompt` whose text
 * matches the NEXT unmatched known local prompt is a turn the controller
 * already has (it captured that turn live through the sandbox proxy) —
 * consume it and keep walking. The first host turn that does NOT match is
 * where local knowledge ends: the cursor is the last turn-end BEFORE it,
 * so everything from that turn onward gets mirrored exactly once.
 *
 * Ordered (not set-membership) on purpose: re-issued prompts later in a
 * conversation legitimately reappear in the host transcript and a
 * set-membership match would wrongly skip them.
 *
 * Exit states: every host turn matched → full tip is known, cursor is the
 * last turn-end; no local prompts (or the first host prompt already
 * unknown) → 0, mirror everything. A transcript longer than one page
 * leaves the seed `undefined` — the caller merges from 0 (a possible
 * duplicate beats any lost content) rather than trusting a partial walk.
 */
export function seedWalkForTranscript(
  localTexts: readonly string[],
  hostRecords: readonly HostEventRecord[],
): number | undefined {
  if (localTexts.length === 0) return 0
  let lastTurnEndSeq: number | undefined
  const queue = [...localTexts]
  for (const rec of hostRecords) {
    const seq = typeof rec["seq"] === "number" ? rec["seq"] : undefined
    const kind = rec["kind"]
    if (kind === "turn-end") {
      lastTurnEndSeq = seq ?? lastTurnEndSeq
      continue
    }
    if (kind === "user-prompt" && typeof rec["text"] === "string") {
      if (queue.length > 0 && queue[0] === rec["text"]) {
        queue.shift()
        continue
      }
      return lastTurnEndSeq ?? 0
    }
  }
  // Walked past every local prompt without a mismatch — controller already
  // knows everything reachable. Both the tip and the post-walk cursor of
  // the first sync then agree on "skip all known turns".
  return lastTurnEndSeq ?? 0
}

/* ── record mapping ──────────────────────────────────────────────── */

/** Host record kinds this mirror skillfully reproduces controller-side. */
const MIRRORED_KINDS = new Set([
  "user-prompt",
  "text-delta",
  "thought",
  "tool-call",
  "tool-result",
  "notice",
  "error",
  "plan",
  "turn-end",
])

/** Turn a raw host record into the controller-transcript record the mirror
 *  appends — same `kind` (so every existing transcript renderer renders it
 *  unchanged) plus the three mirror tags, and the HOST's own `ts` preserved
 *  inside the record. `undefined` for kinds that carry conversations the
 *  controller doesn't derive value from duplicating (`system-prompt`,
 *  `usage_update`, derived `tool-call-record`, …). */
export function hostRecordToMirrorRecord(
  rec: HostEventRecord,
  hostFingerprint: string,
): Record<string, unknown> | undefined {
  const kind = rec["kind"]
  if (typeof kind !== "string" || !MIRRORED_KINDS.has(kind)) return undefined
  const tags = {
    origin: DEVICE_ORIGIN,
    hostSeq: rec["seq"],
    sourceRef: `device:${hostFingerprint}`,
    ...((typeof rec["ts"] === "string" ? { ts: rec["ts"] } : {}) as Record<string, unknown>),
  }
  switch (kind) {
    case "user-prompt":
      return { ...tags, kind, text: rec["text"] }
    case "text-delta":
    case "thought":
    case "notice":
      return { ...tags, kind, text: rec["text"] }
    case "error":
      return { ...tags, kind, error: rec["error"] ?? rec["text"] }
    case "plan":
      return { ...tags, kind, text: rec["text"] }
    case "tool-call":
      return {
        ...tags,
        kind,
        toolCallId: rec["toolCallId"],
        toolName: rec["toolName"],
        ...(rec["arguments"] !== undefined ? { arguments: rec["arguments"] } : {}),
        ...(rec["isUpdate"] ? { isUpdate: true } : {}),
      }
    case "tool-result":
      return {
        ...tags,
        kind,
        toolCallId: rec["toolCallId"],
        ...(rec["result"] !== undefined ? { result: rec["result"] } : {}),
        ...(rec["isError"] ? { isError: true } : {}),
      }
    case "turn-end":
      return { ...tags, kind }
    default:
      return undefined
  }
}

/* ── the sync entry point ────────────────────────────────────────── */

/** The slice of `SessionsRegistry` (and the descriptor) the sync needs —
 *  kept narrow so tests can stub the registry. */
export interface DeviceMirrorTarget {
  findByIdOrName(idOrName: string): SessionDescriptor | undefined
  appendDeviceMirrorRecords(
    id: string,
    records: readonly Record<string, unknown>[],
  ): number
  /** Preferred cursor/prompt source — the registry's own scan (correct
   *  transcript base dir). Falls back to this module's default-dir fs read
   *  when absent (older registry shapes / direct unit calls). */
  scanDeviceMirrorState?(id: string): {
    cursor: number
    localPromptTexts: readonly string[]
  }
}

export type DeviceMirrorSyncResult =
  | {
      ok: true
      /** New records merged from the host this call. */
      merged: number
      /** The advanced mirror cursor after the merge. */
      cursor: number
    }
  | { ok: false; reason: "no-session" | "not-device" | "no-host-registry"; error?: string }
  | { ok: false; reason: "mirror-error"; error: string }

/**
 * One read-time sync for a controller id/name. Fast no-op path: no local
 * descriptor, or not a device-mirrored session (both fields absent) —
 * local spawns pay ZERO extra reads/calls (P7b test invariant). Reads the
 * cursor, dials the host, appends new records, refreshes the descriptor's
 * live projection fields, and stamps/clears `mirrorError` on the
 * descriptor for unreachable-host surfacing.
 */
export async function syncDeviceMirror(
  sessions: DeviceMirrorTarget,
  hosts: HostRegistry | undefined,
  idOrName: string,
): Promise<DeviceMirrorSyncResult> {
  const desc = sessions.findByIdOrName(idOrName)
  if (!desc) return { ok: false, reason: "no-session" }
  // Both fields must be present — `hostSessionId` alone (older host, no id
  // returned) skips silently (P7b-2 / current behaviour).
  if (!desc.hostSessionId || !desc.hostFingerprint) {
    return { ok: false, reason: "not-device" }
  }
  if (!hosts) return { ok: false, reason: "no-host-registry" }

  const mirrorTarget = {
    hostFingerprint: desc.hostFingerprint,
    hostSessionId: desc.hostSessionId,
  }

  // P7b-3 — the cursor derives from the durable events file. cursor === 0
  // means nothing has EVER been mirrored: seed once (see
  // seedWalkForTranscript's doc) from the host's full page so turns the
  // controller captured live through the sandbox proxy (the spawn turn and
  // any `agent_prompt`-driven turns) are skipped rather than re-merged as
  // device-tagged duplicates.
  const state = sessions.scanDeviceMirrorState
    ? sessions.scanDeviceMirrorState(desc.id)
    : {
        cursor: await mirrorCursorForSession(desc.id),
        localPromptTexts: await localUserPromptTexts(desc.id),
      }
  let cursor = state.cursor
  let merged = 0
  let maxSeq = cursor
  const toAppend: Record<string, unknown>[] = []
  const seedAndMerge = (seed: number, events: HostEventRecord[]): void => {
    cursor = seed
    for (const rec of events) {
      const seq = typeof rec["seq"] === "number" ? rec["seq"] : undefined
      if (seq !== undefined && seq <= cursor) continue
      if (seq !== undefined && seq > maxSeq) maxSeq = seq
      const mirrorRecord = hostRecordToMirrorRecord(rec, mirrorTarget.hostFingerprint)
      if (mirrorRecord) toAppend.push(mirrorRecord)
    }
  }
  if (cursor === 0) {
    const seedPage = await fetchHostTurns(
      hosts,
      mirrorTarget.hostFingerprint,
      mirrorTarget.hostSessionId,
      0,
    )
    if (!seedPage.ok) {
      return stampMirrorError(desc, seedPage.error, seedPage.staleAt)
    }
    seedAndMerge(seedWalkForTranscript(state.localPromptTexts, seedPage.events) ?? 0, seedPage.events)
  } else {
    const nextPage = await fetchHostTurns(
      hosts,
      mirrorTarget.hostFingerprint,
      mirrorTarget.hostSessionId,
      cursor,
    )
    if (!nextPage.ok) {
      return stampMirrorError(desc, nextPage.error, nextPage.staleAt)
    }
    for (const rec of nextPage.events) {
      const seq = typeof rec["seq"] === "number" ? rec["seq"] : undefined
      if (seq !== undefined) {
        if (seq <= cursor) continue // idempotence: never re-append
        if (seq > maxSeq) maxSeq = seq
      }
      const mirrorRecord = hostRecordToMirrorRecord(rec, mirrorTarget.hostFingerprint)
      if (mirrorRecord) toAppend.push(mirrorRecord)
    }
  }
  if (toAppend.length > 0) {
    merged = sessions.appendDeviceMirrorRecords(desc.id, toAppend)
  }
  refreshDescriptorFromHost(desc, await fetchHostDescriptorSnapshot(hosts, mirrorTarget))
  delete desc.mirrorError
  return { ok: true, merged, cursor: maxSeq }
}

function stampMirrorError(
  desc: SessionDescriptor,
  error: string,
  staleAt?: string,
): { ok: false; reason: "mirror-error"; error: string } {
  desc.mirrorError = staleAt
    ? `${error} (capturedAt ${staleAt})`
    : error
  return { ok: false, reason: "mirror-error", error: desc.mirrorError }
}

async function fetchHostDescriptorSnapshot(
  hosts: HostRegistry,
  tier: { hostFingerprint: string; hostSessionId: string },
): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await hosts.forwardHttp(tier.hostFingerprint, {
      method: "GET",
      path: `/sessions/${encodeURIComponent(tier.hostSessionId)}`,
    })
    if (res.stale || res.status !== 200) return undefined
    const parsed: unknown = JSON.parse(Buffer.from(res.body).toString("utf8"))
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** Cheap live-projection refresh (P7b-2's last bullet): copy the host
 *  snapshot's liveness/activity/usage scalars onto the controller
 *  descriptor. Controller-local fields (label, agentsMdMode, sandboxId…)
 *  are NEVER touched; absent host fields leave the controller's own
 *  values alone. */
function refreshDescriptorFromHost(
  desc: SessionDescriptor,
  host: Record<string, unknown> | undefined,
): void {
  if (!host) return
  const hostLastActivity = host["lastActivityAt"]
  if (typeof hostLastActivity === "string") {
    if (
      !desc.lastActivityAt ||
      Date.parse(hostLastActivity) > Date.parse(desc.lastActivityAt)
    ) {
      desc.lastActivityAt = hostLastActivity
    }
  }
  if (typeof host["busy"] === "boolean") {
    const alreadyBusy = desc.busy === true
    if (alreadyBusy !== host["busy"]) desc.busy = host["busy"]
  }
  const hostPhase = host["currentPhase"]
  if (typeof hostPhase === "string" && hostPhase.length > 0) {
    desc.currentPhase = hostPhase as SessionDescriptor["currentPhase"]
  }
  if (typeof host["costUsd"] === "number" && !Number.isNaN(host["costUsd"] as number)) {
    const cost = host["costUsd"] as number
    if (desc.costUsd === undefined || cost > desc.costUsd) desc.costUsd = cost
  }
  if (typeof host["tokensIn"] === "number") desc.tokensIn = host["tokensIn"] as number
  if (typeof host["tokensOut"] === "number") desc.tokensOut = host["tokensOut"] as number
  if (!desc.model && typeof host["model"] === "string" && host["model"].length > 0) {
    desc.model = host["model"]
  }
  if (!desc.lastOutputAt && typeof host["lastOutputAt"] === "string") {
    desc.lastOutputAt = host["lastOutputAt"] as string
  }
}
