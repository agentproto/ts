import type { ChipStatus, DetailLane, Finding, LaneSummary, ReviewRow, RowStatus, RunDetail, RubricDigest, Severity } from "./types.js"

export function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/** `<base7>..<head7>` — never truncates a sha shorter than 7 (rare, but a
 *  short synthetic sha in a test fixture shouldn't throw). */
export function shortRange(baseSha?: string, headSha?: string): string {
  if (!baseSha || !headSha) return "—"
  return `${baseSha.slice(0, 7)}..${headSha.slice(0, 7)}`
}

/** Relative age from `createdAt` to `now` (default: real time) — "3m", "2h",
 *  "5d", or "just now" under a minute. */
export function ageOf(createdAt: string, now: number = Date.now()): string {
  const ms = now - new Date(createdAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return "just now"
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** The verdict/status chip — one visual language for pass/block/incomplete/
 *  running/cancelled/failed everywhere it appears (list row, detail header).
 *  The label is the status itself; only the CSS class needs the `v-`
 *  prefix, so there is nothing to get out of sync. */
export function verdictChip(status: ChipStatus): string {
  return `<span class="chip chip-verdict v-${esc(status)}">${esc(status)}</span>`
}

const LANE_STATUS_LABEL: Record<LaneSummary["status"], string> = {
  pass: "pass",
  fail: "fail",
  skipped: "skipped",
  timeout: "timeout",
}

export function laneStatusChip(status: LaneSummary["status"]): string {
  return `<span class="chip chip-lane l-${esc(status)}">${esc(LANE_STATUS_LABEL[status])}</span>`
}

export function severityTag(severity: Severity): string {
  return `<span class="tag sev-${esc(severity)}">${esc(severity)}</span>`
}

function requesterLabel(row: Pick<ReviewRow, "requester">): string {
  const r = row.requester
  if (!r) return "—"
  const id = r.sessionId ? esc(r.sessionId) : ""
  const author = r.gitAuthor ? esc(r.gitAuthor.name) : ""
  if (id && author) return `${id} <span class="muted">(${author})</span>`
  return id || author || "—"
}

function prLabel(row: Pick<ReviewRow, "pr" | "prState">): string {
  if (!row.pr) return "—"
  const state = row.prState ? ` <span class="tag pr-${esc(row.prState)}">${esc(row.prState)}</span>` : ""
  return `<a href="${esc(row.pr.url)}" target="_blank" rel="noopener">#${row.pr.number}</a>${state}`
}

/** One list row. `data-runid` drives the click-to-open-detail handler. */
export function renderRow(row: ReviewRow): string {
  const status: RowStatus = row.status ?? row.verdict ?? "incomplete"
  const flags: string[] = []
  if (row.dirty) flags.push('<span class="tag t-dirty">dirty</span>')
  if (row.cached) flags.push('<span class="tag t-cached">cached</span>')
  return (
    `<tr class="row" data-runid="${esc(row.runId)}" tabindex="0">` +
    `<td>${verdictChip(status)}</td>` +
    `<td class="mono">${esc(shortRange(row.baseSha, row.headSha))}</td>` +
    `<td>${esc(row.binding ?? "—")}</td>` +
    `<td class="mono">${esc(row.repoRemote ?? "—")}</td>` +
    `<td>${requesterLabel(row)}</td>` +
    `<td>${prLabel(row)}</td>` +
    `<td>${flags.join(" ") || "—"}</td>` +
    `<td>${esc(ageOf(row.createdAt))}</td>` +
    `</tr>`
  )
}

/** The list view: running rows first (already ordered by the caller — this
 *  never re-sorts), then settled ones, newest first. */
export function renderList(rows: readonly ReviewRow[]): string {
  if (rows.length === 0) return '<div class="empty">No reviews recorded yet.</div>'
  const header =
    "<tr><th>Verdict</th><th>Range</th><th>Binding</th><th>Repo</th><th>Requester</th><th>PR</th><th>Flags</th><th>Age</th></tr>"
  return `<table class="list"><thead>${header}</thead><tbody>${rows.map(renderRow).join("")}</tbody></table>`
}

function findingLine(f: Finding): string {
  const loc = f.file ? `${esc(f.file)}${f.line ? `:${f.line}` : ""}` : ""
  return (
    `<details class="finding">` +
    `<summary>${severityTag(f.severity)} ${esc(f.title)}${loc ? ` <span class="mono muted">${loc}</span>` : ""}</summary>` +
    `<div class="finding-detail">${esc(f.detail)}</div>` +
    `</details>`
  )
}

/** One lane's detail block: status/blocking/duration/error head, findings,
 *  and — for an agent lane — model/preset/rubric sha + a link to the
 *  reviewer session (opens the live-session panel; see main.ts). */
export function renderLaneDetail(lane: DetailLane, rubrics: readonly RubricDigest[] = []): string {
  const parts: string[] = []
  parts.push(`<div class="lane-hdr">`)
  parts.push(`<span class="lane-id">${esc(lane.id)}</span>`)
  parts.push(laneStatusChip(lane.status))
  parts.push(`<span class="tag ${lane.blocking ? "t-blocking" : "t-advisory"}">${lane.blocking ? "blocking" : "advisory"}</span>`)
  if (lane.durationMs !== undefined) parts.push(`<span class="muted">${(lane.durationMs / 1000).toFixed(1)}s</span>`)
  parts.push(`</div>`)
  if (lane.error) parts.push(`<div class="lane-error">${esc(lane.error)}</div>`)
  if (lane.sessionId || lane.preset || lane.model) {
    const rubric = rubrics.find(r => r.check === lane.id)
    const bits: string[] = []
    if (lane.model) bits.push(`model: ${esc(lane.model)}`)
    if (lane.preset) bits.push(`preset: ${esc(lane.preset)}`)
    if (rubric) bits.push(`rubric: <span class="mono">${esc(rubric.sha256.slice(0, 12))}</span>`)
    if (lane.sessionId) {
      bits.push(
        `reviewer: <button class="sess-link" data-session-id="${esc(lane.sessionId)}">${esc(lane.sessionId)}</button>`,
      )
    }
    parts.push(`<div class="lane-agent-meta">${bits.join(" · ")}</div>`)
  }
  if (lane.findings.length > 0) parts.push(`<div class="findings">${lane.findings.map(findingLine).join("")}</div>`)
  return `<div class="lane">${parts.join("")}</div>`
}

/** The full detail view for one run — header (verdict/binding/cached/error)
 *  plus every lane. */
export function renderDetail(detail: RunDetail): string {
  const status: ChipStatus =
    detail.status === "done" ? (detail.verdict ?? "incomplete") : detail.status
  const header: string[] = [`<div class="detail-hdr">`, verdictChip(status), `<span class="mono">${esc(detail.runId)}</span>`]
  if (detail.binding) header.push(`<span class="tag">${esc(detail.binding)}</span>`)
  if (detail.cached) header.push('<span class="tag t-cached">cached</span>')
  header.push(`</div>`)
  if (detail.error) header.push(`<div class="detail-error">${esc(detail.error)}</div>`)
  if (detail.supersededBy) header.push(`<div class="muted">superseded by ${esc(detail.supersededBy)}</div>`)

  const fullLanes = detail.attestation?.lanes
  const rubrics = detail.attestation?.rubrics ?? []
  let body: string
  if (fullLanes) {
    body = fullLanes.map(l => renderLaneDetail(l, rubrics)).join("")
  } else if (detail.lanes) {
    body = detail.lanes.map(l => `<div class="lane"><div class="lane-hdr"><span class="lane-id">${esc(l.id)}</span>${laneStatusChip(l.status)}</div></div>`).join("")
  } else {
    body = ""
  }
  return `<div class="detail">${header.join("")}${body}</div>`
}
