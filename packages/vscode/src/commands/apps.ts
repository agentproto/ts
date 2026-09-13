/**
 * Commands for the Apps tree view.
 *
 * - refreshApps forces the tree to reload the daemon's installed apps.
 * - openAppPanel opens an app's UI in its webview panel; without a tree
 *   node (command palette) it offers a QuickPick of the apps that ship a UI.
 * - openAppInBrowser opens an app's UI in the standalone HTTP host (a real
 *   browser tab), where clicks and native keyboard shortcuts work — unlike
 *   the webview panel, which VS Code strips of editor shortcuts (Cmd+C/V/F…)
 *   and where the inner iframe needs a click to take focus.
 * - openAppManifest shows the markdown manifest behind a row — APP.md for
 *   an app, AGENT.md / WORKFLOW.md for its children — as a read-only
 *   document (the files belong to the daemon's install, not the workspace).
 * - runAppWorkflow starts a workflow row on the daemon (`workflow_run_file`
 *   on its emitted WORKFLOW.md), after an optional JSON input.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import { getConfig } from "../config.js"
import type { InstalledAppInfo, InstalledAppRef } from "../client/types.js"
import { registerOutputDocuments, type OutputDocuments } from "../services/outputDocument.js"
import {
  appLabel,
  appsWithUi,
  manifestDocumentName,
  nodeManifestPath,
  type AppNode,
  type AppsTreeNode,
} from "../views/appsTree.logic.js"
import type { AppsTreeProvider } from "../views/appsTree.js"
import type { AppPanels } from "../webview/appPanel.js"
import { appStandaloneUrl } from "../webview/appPanel.logic.js"
import { describeWorkflowRun, parseWorkflowInput, workflowPickItems } from "./apps.logic.js"

/** Own scheme: the transcript panel already owns `agentproto-output`, and a
 *  scheme can only be registered once per extension host. */
const MANIFEST_SCHEME = "agentproto-app-manifest"

export function registerAppCommands(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  appPanels: AppPanels,
  provider: AppsTreeProvider,
): void {
  const manifestDocs = registerOutputDocuments(ctx, MANIFEST_SCHEME)
  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentproto.refreshApps", () => {
      void provider.refresh()
    }),
    vscode.commands.registerCommand("agentproto.openAppPanel", (node?: AppNode) => {
      void openAppPanel(client, appPanels, node)
    }),
    vscode.commands.registerCommand("agentproto.openAppInBrowser", (node?: AppNode) => {
      void openAppInBrowser(client, node)
    }),
    vscode.commands.registerCommand("agentproto.openAppManifest", (node?: AppsTreeNode) => {
      void openAppManifest(client, manifestDocs, node)
    }),
    vscode.commands.registerCommand("agentproto.runAppWorkflow", (node?: AppsTreeNode) => {
      void runAppWorkflow(client, node)
    }),
  )
}

async function openAppPanel(
  client: DaemonClient,
  appPanels: AppPanels,
  node?: AppNode,
): Promise<void> {
  if (node?.app?.ui) {
    appPanels.open(node.app)
    return
  }

  const app = await pickAppWithUi(client)
  if (app) appPanels.open(app)
}

async function listAppsOrReport(client: DaemonClient): Promise<InstalledAppInfo[] | undefined> {
  try {
    return await client.listApps()
  } catch (err) {
    void vscode.window.showErrorMessage(
      `List apps failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return undefined
  }
}

/** Resolve an app with a UI panel, from a tree node or a QuickPick. */
async function pickAppWithUi(client: DaemonClient): Promise<InstalledAppInfo | undefined> {
  const all = await listAppsOrReport(client)
  if (!all) return undefined
  const apps = appsWithUi(all)
  if (apps.length === 0) {
    void vscode.window.showInformationMessage("No installed apps with a UI.")
    return undefined
  }

  const pick = await vscode.window.showQuickPick(
    apps.map(app => ({
      label: appLabel(app),
      description: app.appId,
      app,
    })),
    { placeHolder: "Select an app to open" },
  )
  return pick?.app
}

/** Open an app's standalone HTTP UI in a real browser. Prefers VS Code's
 *  built-in Simple Browser (stays inside VS Code but is a genuine browser —
 *  clicks + native shortcuts work); falls back to the OS browser when the
 *  Simple Browser command isn't available. */
async function openAppInBrowser(client: DaemonClient, node?: AppNode): Promise<void> {
  let app = node?.app
  if (!app?.ui) app = await pickAppWithUi(client)
  if (!app) return

  const url = appStandaloneUrl(getConfig().daemonUrl, app.appId)

  // The built-in Simple Browser exposes `simpleBrowser.api.open`; it throws
  // "command not found" when the built-in extension is unavailable.
  let opened = false
  try {
    await vscode.commands.executeCommand("simpleBrowser.api.open", url)
    opened = true
  } catch {
    opened = false
  }

  if (!opened) {
    try {
      await vscode.env.openExternal(vscode.Uri.parse(url))
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Open app '${app.appId}' in browser failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}

/** Show the manifest behind a row read-only. From the palette (no node) it
 *  asks which app's APP.md to open. */
async function openAppManifest(
  client: DaemonClient,
  docs: OutputDocuments,
  node?: AppsTreeNode,
): Promise<void> {
  let target = node
  if (!target || target.kind === "empty" || target.kind === "category") {
    const app = await pickAnyApp(client)
    if (!app) return
    target = { kind: "app", app }
  }

  const path = nodeManifestPath(target)
  if (!path) {
    void vscode.window.showInformationMessage(
      "This daemon doesn't report where the app is installed — upgrade it to browse manifests.",
    )
    return
  }

  let text: string
  try {
    text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(path)))
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Open manifest failed (${path}): ${err instanceof Error ? err.message : String(err)}`,
    )
    return
  }
  await docs.show(manifestDocumentName(target), text)
}

async function pickAnyApp(client: DaemonClient): Promise<InstalledAppInfo | undefined> {
  const apps = await listAppsOrReport(client)
  if (!apps) return undefined
  if (apps.length === 0) {
    void vscode.window.showInformationMessage("No apps installed.")
    return undefined
  }
  const pick = await vscode.window.showQuickPick(
    apps.map(app => ({ label: appLabel(app), description: app.appId, app })),
    { placeHolder: "Select an app" },
  )
  return pick?.app
}

/** Start a workflow on the daemon. From a workflow row the target is fixed;
 *  from the palette it's picked across every installed app. */
async function runAppWorkflow(client: DaemonClient, node?: AppsTreeNode): Promise<void> {
  let target: { app: InstalledAppInfo; ref: InstalledAppRef } | undefined
  if (node?.kind === "workflow") {
    target = { app: node.app, ref: node.ref }
  } else {
    const apps = await listAppsOrReport(client)
    if (!apps) return
    const items = workflowPickItems(apps)
    if (items.length === 0) {
      void vscode.window.showInformationMessage("No installed app bundles a workflow.")
      return
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: "Select a workflow to run" })
    if (!pick) return
    target = { app: pick.app, ref: pick.ref }
  }

  const raw = await vscode.window.showInputBox({
    title: `Run workflow "${target.ref.id}" (${appLabel(target.app)})`,
    prompt: "Optional input, as a JSON object — bound to $input in the workflow. Leave empty for none.",
    placeHolder: '{"topic": "…"}',
    validateInput: value => {
      const parsed = parseWorkflowInput(value)
      return parsed.ok ? undefined : parsed.error
    },
  })
  if (raw === undefined) return // dismissed

  const parsed = parseWorkflowInput(raw)
  if (!parsed.ok) {
    void vscode.window.showErrorMessage(parsed.error)
    return
  }

  try {
    const run = await client.runWorkflowFile({
      path: target.ref.path,
      ...(target.app.dir ? { cwd: target.app.dir } : {}),
      ...(parsed.input ? { input: parsed.input } : {}),
    })
    void vscode.window.showInformationMessage(describeWorkflowRun(target.ref.id, run))
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Run workflow "${target.ref.id}" failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
