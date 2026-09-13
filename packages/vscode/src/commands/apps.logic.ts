/**
 * Pure helpers for the Apps commands (commands/apps.ts) — no vscode import
 * so they're unit-testable under plain vitest.
 */

import type { InstalledAppInfo, InstalledAppRef, WorkflowRunStart } from "../client/types.js"

export type WorkflowInputParse =
  | { ok: true; input?: Record<string, unknown> }
  | { ok: false; error: string }

/**
 * Parse the "Run workflow…" input box: blank means "no input"; otherwise it
 * must be a JSON object (what `workflow_run_file` binds to `$input`).
 * Returns a message instead of throwing so it doubles as the input box's
 * `validateInput`.
 */
export function parseWorkflowInput(raw: string | undefined): WorkflowInputParse {
  const text = raw?.trim() ?? ""
  if (text === "") return { ok: true }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: `Not valid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "Workflow input must be a JSON object, e.g. {\"topic\": \"…\"}" }
  }
  return { ok: true, input: parsed as Record<string, unknown> }
}

/** One QuickPick row per workflow across every installed app. */
export interface WorkflowPickItem {
  label: string
  description: string
  app: InstalledAppInfo
  ref: InstalledAppRef
}

export function workflowPickItems(apps: InstalledAppInfo[]): WorkflowPickItem[] {
  return apps.flatMap(app =>
    (app.workflows ?? []).map(ref => ({
      label: ref.id,
      description: app.name?.trim() || app.appId,
      app,
      ref,
    })),
  )
}

/** Toast text once the daemon accepted a workflow run. */
export function describeWorkflowRun(workflowId: string, run: WorkflowRunStart | undefined): string {
  if (!run?.runId) return `Workflow "${workflowId}" started.`
  return `Workflow "${workflowId}" started — run ${run.runId} (${run.status}).`
}
