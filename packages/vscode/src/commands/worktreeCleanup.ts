/**
 * agentproto.cleanWorktrees — the destructive-but-guarded worktree half of
 * "clean up". Unlike session clean-up (a one-shot archive), worktree GC is
 * per-repo and irreversible, so this always DRY-RUNS first, shows exactly what
 * would be reclaimed, and only applies on an explicit modal confirm. The
 * daemon's engine keeps anything risky (open PR / live session → held; dirty →
 * salvage, not removed); this command never overrides that.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import {
  gcOutcomeSummary,
  gcPlanSummary,
  isWorktreeGcNotConfigured,
  partitionGcPlan,
  worktreeLabel,
} from "./worktreeCleanup.logic.js"

export function registerWorktreeCleanup(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.cleanWorktrees", () => cleanWorktrees(client)),
  )
}

/** Resolve which repo to sweep from the open folders — the natural "this
 *  project" target. One folder → it; several → ask; none → bail with a hint. */
async function resolveRepoRoot(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? []
  if (folders.length === 0) {
    vscode.window.showWarningMessage(
      "agentproto: open the project folder whose worktrees you want to clean, then run this again.",
    )
    return undefined
  }
  if (folders.length === 1) return folders[0]!.uri.fsPath
  const pick = await vscode.window.showQuickPick(
    folders.map(f => ({ label: f.name, description: f.uri.fsPath, path: f.uri.fsPath })),
    { title: "Clean worktrees for which project?", placeHolder: "Pick the repo to sweep" },
  )
  return pick?.path
}

async function cleanWorktrees(client: DaemonClient): Promise<void> {
  const repoRoot = await resolveRepoRoot()
  if (!repoRoot) return

  // 1. Dry run — mutates nothing.
  let plan
  try {
    plan = await client.gcWorktrees({ repoRoot, apply: false })
  } catch (err) {
    if (isWorktreeGcNotConfigured(err)) {
      vscode.window.showInformationMessage(
        "agentproto: worktree clean-up isn't enabled on this daemon (no gc runner wired).",
      )
      return
    }
    vscode.window.showErrorMessage(
      `agentproto: worktree scan failed — ${err instanceof Error ? err.message : String(err)}`,
    )
    return
  }
  if (plan.mode !== "plan") return
  const part = partitionGcPlan(plan.plan)

  if (part.reclaim.length === 0) {
    vscode.window.showInformationMessage(
      `agentproto: no worktrees to reclaim. ${gcPlanSummary(part)}.`,
    )
    return
  }

  // 2. Confirm — list exactly what will be removed; note what's kept.
  const preview = part.reclaim.slice(0, 8).map(worktreeLabel).join("\n")
  const more = part.reclaim.length > 8 ? `\n…and ${part.reclaim.length - 8} more` : ""
  const kept =
    part.salvage.length || part.hold.length
      ? `\n\nKept: ${gcPlanSummary(part).replace(/^\d+ to reclaim(\s·\s)?/, "") || "none"}.`
      : ""
  const choice = await vscode.window.showWarningMessage(
    `Remove ${part.reclaim.length} merged worktree${part.reclaim.length === 1 ? "" : "s"}? This deletes the checkout(s) on disk.`,
    { modal: true, detail: `${preview}${more}${kept}` },
    "Remove",
  )
  if (choice !== "Remove") return

  // 3. Apply.
  try {
    const res = await client.gcWorktrees({ repoRoot, apply: true })
    const summary = res.mode === "apply" ? gcOutcomeSummary(res.outcomes) : "done"
    vscode.window.showInformationMessage(`agentproto: worktree clean-up — ${summary}.`)
  } catch (err) {
    vscode.window.showErrorMessage(
      `agentproto: worktree clean-up failed — ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
