#!/usr/bin/env node
/**
 * Shared, PURE helpers for the CI artifact ledger.
 *
 * The provenance footer (session id, adapter, sandbox, cost, run link, sha) is
 * stamped AFTER the box has done its work, onto the PR / review / comment the
 * bot just created. It used to find that artifact by DISCOVERY heuristics
 * (scan open bot PRs for a model-written placeholder; pick the newest bot
 * review for a sha), which silently missed whenever the heuristic's premise
 * broke (the model forgot the placeholder, a second review raced in, …).
 *
 * The ledger replaces discovery with a record written at CREATION TIME. Every
 * GitHub side-effect that opens a PR / posts a review / files a comment inside
 * the sandbox flow goes through `deliver-artifact.mjs`, which POSTs the REST
 * call AND emits a machine-readable marker line to stdout:
 *
 *     ::agentproto-artifact::{"kind":"pr","id":123,"number":45,"url":"…","sha":"…"}
 *
 * The `agentproto-run` driver harvests those marker lines out of the agent
 * session's own output (the same transport the `provenance` output already
 * rides) and surfaces them as the action's `artifacts` output. The stamp
 * scripts then key off the id directly instead of re-discovering the artifact,
 * and fall back to the legacy discovery path (with a visible `::warning::`)
 * only when the ledger is empty or absent.
 *
 * This module is IMPORT-SAFE (no side effects, no IO) so the box-side writer
 * (`deliver-artifact.mjs`), the runner-side driver, and the stamp scripts can
 * share one definition of the marker + record shape, and so the pure logic is
 * unit-testable without hitting GitHub.
 */

/** The stdout sentinel a delivery prints so the driver can harvest the record. */
export const ARTIFACT_MARKER = "::agentproto-artifact::"

/** The artifact kinds a ledger record may describe. */
export const ARTIFACT_KINDS = new Set(["pr", "review", "comment"])

/**
 * Build a ledger record from a GitHub REST create response. Returns `null`
 * when the kind is unknown or the response carries no `id` (i.e. the POST did
 * not actually create anything) — the caller treats that as a delivery
 * failure, never a stamped artifact.
 *
 *   kind === "pr"      → id, number, url (html_url), sha (head.sha)
 *   kind === "review"  → id, url (html_url), sha (commit_id)  [no PR number in body]
 *   kind === "comment" → id, url (html_url)
 */
export const buildArtifactRecord = ({ kind, response, sha, sessionId } = {}) => {
  if (!ARTIFACT_KINDS.has(kind)) return null
  const r = response && typeof response === "object" ? response : {}
  const id = typeof r.id === "number" || (typeof r.id === "string" && r.id) ? r.id : undefined
  if (id === undefined) return null
  const number = typeof r.number === "number" ? r.number : undefined
  const url = typeof r.html_url === "string" ? r.html_url : undefined
  const resolvedSha =
    (r.head && typeof r.head.sha === "string" && r.head.sha) ||
    (typeof r.commit_id === "string" && r.commit_id) ||
    (typeof sha === "string" && sha) ||
    undefined
  const record = { kind, id }
  if (number !== undefined) record.number = number
  if (url) record.url = url
  if (resolvedSha) record.sha = resolvedSha
  if (typeof sessionId === "string" && sessionId) record.sessionId = sessionId
  return record
}

/** Render a record as the single stdout marker line the driver harvests. */
export const formatArtifactMarker = (record) => `${ARTIFACT_MARKER}${JSON.stringify(record)}`

/** Render a record as one NDJSON ledger line (newline-terminated). */
export const serializeLedgerLine = (record) => `${JSON.stringify(record)}\n`

/**
 * Harvest every artifact record embedded as a marker line in a blob of agent
 * output. `extra` (e.g. `{ sessionId }`) is merged into any record that does
 * not already carry that field — the driver knows which session it is reading,
 * the box-side writer does not know its own session id. Malformed marker lines
 * are skipped, never thrown.
 */
export const parseArtifactMarkers = (text, extra = {}) => {
  if (typeof text !== "string" || !text.includes(ARTIFACT_MARKER)) return []
  const out = []
  for (const line of text.split("\n")) {
    const idx = line.indexOf(ARTIFACT_MARKER)
    if (idx === -1) continue
    const json = line.slice(idx + ARTIFACT_MARKER.length).trim()
    let record
    try {
      record = JSON.parse(json)
    } catch {
      continue
    }
    if (
      !record ||
      typeof record !== "object" ||
      !ARTIFACT_KINDS.has(record.kind) ||
      record.id === undefined
    ) {
      continue
    }
    for (const [k, v] of Object.entries(extra)) {
      if (record[k] === undefined && v !== undefined && v !== "") record[k] = v
    }
    out.push(record)
  }
  return out
}

/**
 * Parse the `ARTIFACTS` env JSON the stamp scripts read (the driver's
 * `artifacts` output). Returns `[]` for empty / unset / unparseable input so a
 * missing ledger degrades to the discovery fallback rather than throwing.
 */
export const parseArtifacts = (raw) => {
  const s = typeof raw === "string" ? raw.trim() : ""
  if (!s) return []
  try {
    const parsed = JSON.parse(s)
    return Array.isArray(parsed)
      ? parsed.filter((r) => r && typeof r === "object" && ARTIFACT_KINDS.has(r.kind))
      : []
  } catch {
    return []
  }
}

/**
 * Select the artifact of a given kind to stamp. NEWEST wins — the ledger is
 * append-ordered, so the last record of a kind is the one this run just
 * created (an earlier one would be from a prior attempt). Records without an
 * `id` are ignored. Returns `null` when the ledger has no match.
 */
export const pickArtifact = (artifacts, kind) => {
  if (!Array.isArray(artifacts)) return null
  let picked = null
  for (const r of artifacts) {
    if (r && typeof r === "object" && r.kind === kind && r.id !== undefined) picked = r
  }
  return picked
}
