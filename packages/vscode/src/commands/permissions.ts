/**
 * agentproto.approvePermission / agentproto.denyPermission — resolve a
 * pending ACP permission via POST /permissions/:id (recon §HTTP routes).
 *
 * `arg` comes from one of three call sites:
 *  - a PermissionTreeItem (inline/context-menu action) — carries `permissionId`;
 *  - a toast button payload (views/permissionsTree.ts's notifyNewPermission)
 *    — a bare permission id string;
 *  - undefined (command palette) — falls back to a quick-pick over
 *    `store.permissions`.
 *
 * Approve resolves an optionId when the request carries ACP `options`:
 * a single allow-flavored option is used directly, multiple are quick-picked
 * (see permissions.logic.ts's selectApprovalOption). Deny is passed through
 * without an optionId — the daemon maps decision → a reject-flavored option
 * itself (packages/runtime/src/sessions.ts PermissionRespondInput).
 */

import * as vscode from "vscode"

import { extractPermissionId, selectApprovalOption } from "./permissions.logic.js"
import type { DaemonClient } from "../client/daemonClient.js"
import type { PendingPermission } from "../client/types.js"
import type { SessionStore } from "../services/sessionStore.js"

export function registerPermissionCommands(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.approvePermission", (arg?: unknown) =>
      resolvePermission(client, store, "approve", arg),
    ),
    vscode.commands.registerCommand("agentproto.denyPermission", (arg?: unknown) =>
      resolvePermission(client, store, "deny", arg),
    ),
  )
}

async function resolvePermission(
  client: DaemonClient,
  store: SessionStore,
  decision: "approve" | "deny",
  arg: unknown,
): Promise<void> {
  const id = extractPermissionId(arg) ?? (await pickPendingPermission(store))
  if (!id) return

  const perm = store.permissions.find(p => p.id === id)
  if (!perm) {
    void vscode.window.showWarningMessage("That permission is no longer pending.")
    return
  }

  let optionId: string | undefined
  if (decision === "approve") {
    optionId = await pickApprovalOptionId(perm)
    if (optionId === undefined && perm.options.length > 0) return // user cancelled the quick-pick
  }

  try {
    await client.respondPermission(id, {
      decision,
      ...(optionId ? { optionId } : {}),
    })
    await store.refreshAll()
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Failed to ${decision} permission: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** Resolves the optionId an approve should carry, quick-picking on ambiguity. */
async function pickApprovalOptionId(perm: PendingPermission): Promise<string | undefined> {
  const selection = selectApprovalOption(perm.options)
  if (selection.kind === "none") return undefined
  if (selection.kind === "single") return selection.optionId
  const picked = await vscode.window.showQuickPick(
    selection.candidates.map(c => ({
      label: c.name?.trim() || c.optionId,
      description: c.kind,
      optionId: c.optionId,
    })),
    { placeHolder: "Choose how to approve" },
  )
  return picked?.optionId
}

async function pickPendingPermission(store: SessionStore): Promise<string | undefined> {
  const perms = store.permissions
  if (perms.length === 0) {
    void vscode.window.showInformationMessage("No pending permissions.")
    return undefined
  }
  if (perms.length === 1) return perms[0]!.id
  const picked = await vscode.window.showQuickPick(
    perms.map(p => ({
      label: p.toolName?.trim() || p.text.split("\n")[0]?.trim() || "Permission request",
      description: p.sessionId,
      id: p.id,
    })),
    { placeHolder: "Select a pending permission" },
  )
  return picked?.id
}
