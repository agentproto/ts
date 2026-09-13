/**
 * Release-update command — the IO that turns a decided prompt into a command
 * to USERS, never an auto-run. All decision logic lives in
 * releaseUpdate.logic.ts (no vscode) + releaseCheck.logic.ts; this file only:
 *  - shows the "update available" prompt with Update now / Later / Not now;
 *  - persists the snooze (Later / Not now) in globalState;
 *  - runs the Update-now plan:
 *      - `tarball`   → `npm i -g @agentproto/cli@<latest>` then a clean
 *                      daemon restart, both with progress + result surfaced;
 *      - `workspace` → NEVER run here: open an integrated terminal pre-filled
 *                      with the git+rebuild+restart commands and a risk note,
 *                      and let the user press Enter themselves.
 *  - after a successful tarball update, triggers a re-check so the indicator
 *    returns to `current`.
 *
 * Execution only ever happens via the `update` branch of decideUpdateFlow —
 * `later` and `not-now` produce no plan, so nothing can run without an
 * explicit Update now (see releaseUpdate.logic.test.ts).
 */

import { execFile } from "node:child_process"

import * as vscode from "vscode"

import {
  decideUpdateFlow,
  decideUpdatePrompt,
  type ReleaseSnooze,
  type UpdateDecision,
  type UpdatePlan,
  type UpdatePromptInput,
} from "../services/releaseUpdate.logic.js"

/** globalState key for the persisted snooze. */
const SNOOZE_KEY = "releaseUpdate.snooze"

/** Read the persisted snooze from globalState (best-effort; missing/malformed
 *  → no snooze). */
export function readSnooze(ctx: vscode.ExtensionContext): ReleaseSnooze | null {
  const raw: unknown = ctx.globalState.get(SNOOZE_KEY)
  if (!raw || typeof raw !== "object") return null
  const s = raw as ReleaseSnooze
  if (s.kind === "later" && typeof s.untilMs === "number") return s
  if (s.kind === "version" && typeof s.version === "string") return s
  return null
}

async function writeSnooze(
  ctx: vscode.ExtensionContext,
  snooze: ReleaseSnooze | null,
): Promise<void> {
  await ctx.globalState.update(SNOOZE_KEY, snooze)
}

export interface ReleaseUpdateDeps {
  ctx: vscode.ExtensionContext
  /** Re-run the release check + repaint the indicator (after a successful
   *  update, so it flips back to `current`). */
  refresh: () => void
  /** Release poll TTL (ms) — used to size the "Later" snooze window. */
  ttlMs: number
}

/**
 * Decide + show the release-update prompt. Returns the effective decision
 * (or null when silent: no update / unknown / snoozed). No-ops without an
 * actual update.
 */
export async function showReleaseUpdatePrompt(
  deps: ReleaseUpdateDeps,
  input: UpdatePromptInput,
): Promise<UpdateDecision | null> {
  const decision = decideUpdatePrompt({ ...input, snooze: readSnooze(deps.ctx) })
  if (decision.kind !== "prompt") return null

  const msg = `agentproto v${decision.localVersion} → update to v${decision.latest}`
  const chosen = await vscode.window.showInformationMessage(
    msg,
    { modal: false, detail: updateDetail(decision.target) },
    "Update now",
    "Later",
    "Not now",
  )

  const asDecision: UpdateDecision | undefined =
    chosen === "Update now" ? "update" : chosen === "Later" ? "later" : chosen === "Not now" ? "not-now" : undefined

  const now = Date.now()
  if (!asDecision) {
    // Dismissed (esc / close) — behave like "Later": don't nag before the
    // next TTL.
    await writeSnooze(deps.ctx, { kind: "later", untilMs: now + deps.ttlMs })
    return null
  }

  const flow = decideUpdateFlow(asDecision, decision.latest, now, deps.ttlMs, decision.target)
  await writeSnooze(deps.ctx, flow.snooze)
  if (flow.plan) await runUpdatePlan(decision.target, flow.plan, deps)

  return asDecision
}

/** Human detail line for the prompt, so the user knows what Update now means. */
function updateDetail(target: "tarball" | "workspace"): string | undefined {
  if (target === "tarball") {
    return "Update now installs the release and restarts the daemon."
  }
  return "Update now opens a terminal with the git pull + rebuild + restart commands for you to run."
}

async function runUpdatePlan(
  target: "tarball" | "workspace",
  plan: UpdatePlan,
  deps: ReleaseUpdateDeps,
): Promise<void> {
  if (plan.kind === "workspace") {
    // Never run this silently — hand the user a pre-filled terminal.
    openWorkspaceUpdateTerminal(plan)
    return
  }
  const ok = await runTarballUpdate(plan)
  if (!ok) {
    void vscode.window.showErrorMessage(
      "agentproto: update failed — the daemon still runs the previous version.",
    )
    return
  }
  // After a successful npm install + restart, re-check so the indicator
  // returns to `current`. Give the restarted daemon a beat to come up.
  setTimeout(() => deps.refresh(), 1500)
}

/** Workspace update: open a pre-filled terminal + risk note. NEVER run here. */
function openWorkspaceUpdateTerminal(plan: Extract<UpdatePlan, { kind: "workspace" }>): void {
  const terminal = vscode.window.createTerminal({
    name: plan.label,
    location: { viewColumn: vscode.ViewColumn.Active },
  })
  terminal.show()
  terminal.sendText("# " + plan.riskNote, true)
  for (const cmd of plan.commands) terminal.sendText(cmd, true)
}

/** Tarball update: `npm i -g @agentproto/cli@<latest>`, then `daemon restart`,
 *  with progress + result surfaced. Rejects on failure. */
async function runTarballUpdate(plan: Extract<UpdatePlan, { kind: "tarball" }>): Promise<boolean> {
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "agentproto: installing CLI release…",
        cancellable: false,
      },
      () => execUpdateSteps([plan.installCommand, plan.restartCommand]),
    )
    await vscode.window.showInformationMessage(
      `agentproto: updated to v${versionFromInstall(plan.installCommand)}`,
    )
    return true
  } catch (err) {
    return false
  }
}

function versionFromInstall(installCommand: string): string {
  return installCommand.match(/@(\d+(?:\.\d+)*)$/)?.[1] ?? "latest"
}

/** Run the plan's shell commands in order via `sh -c`, surfacing the last
 *  output. Each is a single user-authored command string (e.g. a npm install
 *  or a daemon restart); this is the ONE place a `tarball` plan executes. */
async function execUpdateSteps(commands: string[]): Promise<void> {
  for (const cmd of commands) {
    await new Promise<void>((resolve, reject) => {
      execFile("/bin/sh", ["-c", cmd], { timeout: 120_000 }, (err, stdout, stderr) => {
        const tail = [stdout, stderr].filter(Boolean).join("\n").trim()
        if (err) {
          reject(new Error(`\`${cmd}\` failed${tail ? `: ${tail}` : ""}`))
          return
        }
        resolve()
      })
    })
  }
}

export type { UpdateDecision, UpdatePromptInput }