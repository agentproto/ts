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

/** `agentproto.appPanelMode` — which panel implementation `agentproto.openAppPanel`
 *  renders an app's UI through. See package.json's enumDescriptions for the
 *  user-facing trade-off; the short version: "srcdoc" (default) works for
 *  every app including builtins, "iframe" gives real built-web-app
 *  rendering but only for installed apps that ship a `ui` block. */
export type AppPanelMode = "srcdoc" | "iframe"

/**
 * Which panel path `openAppPanel` should use for `app`:
 * - "iframe" only when the setting asks for it AND the app has a `ui` block
 *   — a daemon-served HTTP url (`GET /apps/<appId>/ui`) only exists then.
 * - "srcdoc" otherwise: the setting is "srcdoc", or the app has no `ui`
 *   block (a BUILTIN's `app_catalog` entry, or a future app-list record
 *   with none) — builtins are never in the HTTP registry (404), so they
 *   MUST keep using the srcdoc relay regardless of the setting. This is a
 *   silent fallback, matching the rest of this file's fallback discipline
 *   (installedSessionChatApp / resolveSessionOpen in sessionView.logic.ts) —
 *   no warning popup, the app just opens.
 */
export function resolveAppPanelRoute(app: InstalledAppInfo, mode: AppPanelMode): "iframe" | "srcdoc" {
  return mode === "iframe" && app.ui ? "iframe" : "srcdoc"
}
