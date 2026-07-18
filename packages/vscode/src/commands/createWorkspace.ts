/**
 * agentproto.createWorkspace — registers the currently-open, unregistered
 * folder as an agentproto workspace via POST /workspaces (the frozen
 * contract from `.plans/agentproto-vscode-workspace-tree/PLAN.md`:
 * `{ path, slug?, label? }` → the updated WorkspacesConfig).
 *
 * Reached two ways:
 *   - the sessions tree's "Create workspace here" CTA row (see
 *     sessionsGroups.logic.ts's buildCreateWorkspaceCtas — it only appears
 *     when an open VS Code folder resolves to no registered workspace),
 *     which passes the CtaNode itself as the command argument;
 *   - the command palette with no argument, which falls back to resolving
 *     the open folder(s) itself (single folder: silent; multiple: a
 *     picker; none unregistered: an informational no-op).
 *
 * PR A (the isomorphic workspace verbs) may not have landed on the daemon
 * this extension is talking to — a 404 on POST /workspaces means "old
 * daemon", not "bad request", and DaemonClient.addWorkspace already raises
 * that distinctly ({@link WorkspacesRouteMissingError}) so it can be
 * surfaced as a clear "update your daemon" warning instead of an opaque
 * HTTP error.
 */

import * as vscode from "vscode"

import { WorkspacesRouteMissingError, type DaemonClient } from "../client/daemonClient.js"
import type { SessionFilterController } from "./sessionFilter.js"
import { EMPTY_WORKSPACES } from "../services/workspaces.logic.js"
import { buildCreateWorkspaceCtas, isCtaNode, type CtaNode } from "../views/sessionsGroups.logic.js"

export function registerCreateWorkspaceCommand(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  filter: SessionFilterController,
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.createWorkspace", async (arg: unknown) => {
      const cta = await resolveCta(arg, client)
      if (!cta) return
      try {
        await client.addWorkspace(cta.folderPath, { slug: cta.suggestedSlug })
        vscode.window.showInformationMessage(
          `agentproto: workspace "${cta.suggestedSlug}" created for ${cta.folderPath}`,
        )
        // POST /workspaces changes the registry, not the session list — a
        // plain store.refreshAll() would never notice, since it only fires
        // onDidChange when sessions themselves changed. This is the direct
        // route to make the new group show up without waiting for one.
        await filter.refreshWorkspaces()
      } catch (err) {
        if (err instanceof WorkspacesRouteMissingError) {
          vscode.window.showWarningMessage(
            "agentproto: this daemon doesn't support creating workspaces from the editor yet — " +
              "update your agentproto daemon, or run `agentproto workspace add` from the CLI.",
          )
          return
        }
        vscode.window.showErrorMessage(
          `agentproto: could not create workspace — ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }),
  )
}

/** The tree row already carries a ready-made CtaNode as its command
 *  argument; the command palette invokes with no argument, so this
 *  re-derives the same candidate list from the live open folders. */
async function resolveCta(arg: unknown, client: DaemonClient): Promise<CtaNode | undefined> {
  if (isCtaNode(arg)) return arg

  const folders = vscode.workspace.workspaceFolders ?? []
  if (folders.length === 0) {
    vscode.window.showInformationMessage("agentproto: no folder is open.")
    return undefined
  }

  let config
  try {
    config = await client.listWorkspaces()
  } catch {
    config = EMPTY_WORKSPACES
  }

  const ctas = buildCreateWorkspaceCtas(
    config,
    folders.map(f => f.uri.fsPath),
  )
  if (ctas.length === 0) {
    vscode.window.showInformationMessage(
      "agentproto: every open folder already has a registered workspace.",
    )
    return undefined
  }
  if (ctas.length === 1) return ctas[0]

  const picked = await vscode.window.showQuickPick(
    ctas.map(c => ({ label: c.label, description: c.folderPath, cta: c })),
    { placeHolder: "Select a folder to register as an agentproto workspace" },
  )
  return picked?.cta
}
