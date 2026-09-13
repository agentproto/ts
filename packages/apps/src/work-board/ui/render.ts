import { COLUMN_STATUSES, type ColumnStatus, type Task } from "./types.js"

const COLUMN_LABELS: Record<ColumnStatus, string> = {
  pending: "Pending",
  in_progress: "In Progress",
  done: "Done",
  failed: "Failed",
}

export function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/** A cancelled task folds into the Failed column, tagged distinctly — v1
 *  treats both as terminal scrap, and a fifth column for a rarely-used
 *  status isn't worth the width. */
export function columnOf(status: Task["status"]): ColumnStatus {
  return status === "cancelled" ? "failed" : status
}

/** The verification tell — never render an unverified done as gate-passed. */
export function verificationTag(task: Task): string {
  const v = task.verification
  if (v) {
    if (v.kind === "gate") return '<span class="tag t-gate">&#10003; gate</span>'
    if (v.kind === "self-report") return '<span class="tag t-self">self-report</span>'
    if (v.kind === "human") return '<span class="tag t-human">human</span>'
  }
  if (task.status === "in_progress" && task.verify) {
    return '<span class="tag t-gated">gated</span>'
  }
  return ""
}

export function ownerTag(task: Task): string {
  if (!task.owner) return '<span class="tag t-unclaimed">Unclaimed</span>'
  return `<span class="tag t-owner">${esc(task.owner)}</span>`
}

export type CardAction = "claim" | "start" | "done" | "fail" | "release" | "cancel" | "reopen"

export interface ActionSpec {
  label: string
  action: CardAction
  cls: "primary" | "danger" | ""
}

/** Explicit per-card status actions valid from the card's current state —
 *  no drag-and-drop (read-only-safe first, per the panel's docblock). */
export function actionsFor(task: Task): ActionSpec[] {
  if (task.status === "pending") {
    return [
      task.owner
        ? { label: "Start", action: "start", cls: "primary" }
        : { label: "Claim", action: "claim", cls: "primary" },
      { label: "Cancel", action: "cancel", cls: "danger" },
    ]
  }
  if (task.status === "in_progress") {
    return [
      { label: "Done", action: "done", cls: "primary" },
      { label: "Fail", action: "fail", cls: "danger" },
      { label: "Release", action: "release", cls: "" },
      { label: "Cancel", action: "cancel", cls: "danger" },
    ]
  }
  if (task.status === "done") {
    return [{ label: "Reopen", action: "reopen", cls: "" }]
  }
  return []
}

function renderCard(task: Task): string {
  let html = `<div class="card" data-taskid="${esc(task.taskId)}">`
  html += `<div class="c-title">${esc(task.title)}</div>`
  html += `<div class="c-id">#${esc(task.taskId)}</div>`
  html += `<div class="c-row">${ownerTag(task)}${verificationTag(task)}`
  if (task.status === "cancelled") html += '<span class="tag t-cancelled">cancelled</span>'
  html += "</div>"
  if (task.lastVerifyError) {
    html += `<div class="c-err">verify failed: ${esc(task.lastVerifyError)}</div>`
  }
  const actions = actionsFor(task)
  if (actions.length > 0) {
    html += '<div class="c-actions">'
    for (const a of actions) {
      html += `<button class="abtn ${a.cls}" data-taskid="${esc(task.taskId)}" data-action="${a.action}">${a.label}</button>`
    }
    html += "</div>"
  }
  html += "</div>"
  return html
}

export function renderColumns(tasks: readonly Task[]): string {
  let html = ""
  for (const status of COLUMN_STATUSES) {
    const rows = tasks.filter(t => columnOf(t.status) === status)
    html += `<div class="col"><div class="col-hdr"><span>${COLUMN_LABELS[status]}</span><span>${rows.length}</span></div><div class="col-body">`
    html += rows.length === 0 ? '<div class="empty">No tasks</div>' : rows.map(renderCard).join("")
    html += "</div></div>"
  }
  return html
}
