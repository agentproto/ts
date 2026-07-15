/**
 * agentproto.filterSessions / agentproto.searchSessions — the interactive
 * layer over sessionFilter.logic.ts's pure SessionFilterState.
 * registerSessionFilter returns a SessionFilterController that owns the
 * state (persisted in ctx.workspaceState so it survives a window reload)
 * and fires onDidChange whenever either command mutates it; sessionsTree.ts
 * subscribes and rebuilds.
 *
 * Also owns the workspace-label cache the filter picker and the tree both
 * need: GET /workspaces is fetched once at construction and refreshed
 * whenever the session store reports a change (the closest available
 * proxy for "daemon reconnected/refreshed" without reaching into
 * sessionStore.ts). A failed fetch degrades to EMPTY_WORKSPACES rather
 * than throwing, so an old daemon without the route still renders a
 * working tree — labels just fall back to slugs.
 */

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor, WorkspacesConfig } from "../client/types.js"
import type { SessionStore } from "../services/sessionStore.js"
import { EMPTY_WORKSPACES, workspaceLabelsIn } from "../services/workspaces.logic.js"
import {
  adapterIdentitiesIn,
  EMPTY_FILTER,
  type SessionFilterState,
} from "../views/sessionFilter.logic.js"

const STATE_KEY = "agentproto.sessionFilter"

export interface SessionFilterController {
  readonly state: SessionFilterState
  /** Cached GET /workspaces result — EMPTY_WORKSPACES until the first successful fetch. */
  readonly workspaces: WorkspacesConfig
  readonly onDidChange: vscode.Event<void>
  dispose(): void
}

export function registerSessionFilter(
  ctx: vscode.ExtensionContext,
  client: DaemonClient,
  store: SessionStore,
): SessionFilterController {
  const onDidChangeEmitter = new vscode.EventEmitter<void>()
  let state: SessionFilterState =
    ctx.workspaceState.get<SessionFilterState>(STATE_KEY) ?? EMPTY_FILTER
  let workspaces: WorkspacesConfig = EMPTY_WORKSPACES

  const setState = (next: SessionFilterState): void => {
    state = next
    void ctx.workspaceState.update(STATE_KEY, state)
    onDidChangeEmitter.fire()
  }

  const refreshWorkspaces = async (): Promise<void> => {
    try {
      workspaces = await client.listWorkspaces()
    } catch {
      workspaces = EMPTY_WORKSPACES
    }
  }
  void refreshWorkspaces()
  const storeSub = store.onDidChange(() => void refreshWorkspaces())

  const filterSub = vscode.commands.registerCommand("agentproto.filterSessions", () =>
    runFilterPicker(store.sessions, workspaces, state, setState),
  )
  const searchSub = vscode.commands.registerCommand("agentproto.searchSessions", () =>
    runSearchInput(state, setState),
  )
  ctx.subscriptions.push(filterSub, searchSub)

  return {
    get state() {
      return state
    },
    get workspaces() {
      return workspaces
    },
    onDidChange: onDidChangeEmitter.event,
    dispose() {
      storeSub.dispose()
      onDidChangeEmitter.dispose()
    },
  }
}

const STATUS_OPTIONS: ReadonlyArray<{ id: SessionFilterState["status"][number]; label: string }> = [
  { id: "live", label: "Live" },
  { id: "awaiting", label: "Awaiting" },
  { id: "done", label: "Done" },
]

type FilterPickValue =
  | { category: "clear" }
  | { category: "status"; id: SessionFilterState["status"][number] }
  | { category: "workspace"; id: string }
  | { category: "adapter"; id: string }

interface FilterPickItem extends vscode.QuickPickItem {
  value?: FilterPickValue
}

function buildFilterItems(
  sessions: readonly SessionDescriptor[],
  workspaces: WorkspacesConfig,
  state: SessionFilterState,
): FilterPickItem[] {
  const items: FilterPickItem[] = [
    { label: "$(clear-all) Clear filters", value: { category: "clear" }, alwaysShow: true },
    { label: "Status", kind: vscode.QuickPickItemKind.Separator },
  ]
  for (const opt of STATUS_OPTIONS) {
    items.push({
      label: opt.label,
      value: { category: "status", id: opt.id },
      picked: state.status.includes(opt.id),
    })
  }

  const workspaceLabels = workspaceLabelsIn(workspaces, sessions)
  if (workspaceLabels.length > 0) {
    items.push({ label: "Workspace", kind: vscode.QuickPickItemKind.Separator })
    for (const label of workspaceLabels) {
      items.push({
        label,
        value: { category: "workspace", id: label },
        picked: state.workspaces.includes(label),
      })
    }
  }

  const adapters = adapterIdentitiesIn(sessions)
  if (adapters.length > 0) {
    items.push({ label: "Adapter", kind: vscode.QuickPickItemKind.Separator })
    for (const id of adapters) {
      items.push({ label: id, value: { category: "adapter", id }, picked: state.adapters.includes(id) })
    }
  }

  return items
}

async function runFilterPicker(
  sessions: readonly SessionDescriptor[],
  workspaces: WorkspacesConfig,
  state: SessionFilterState,
  setState: (next: SessionFilterState) => void,
): Promise<void> {
  const items = buildFilterItems(sessions, workspaces, state)
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: "Filter sessions by status / workspace / adapter — pick 'Clear filters' to reset",
  })
  if (!picked) return

  if (picked.some(item => item.value?.category === "clear")) {
    setState(EMPTY_FILTER)
    return
  }

  const next: SessionFilterState = { status: [], workspaces: [], adapters: [], search: state.search }
  for (const item of picked) {
    const value = item.value
    if (!value) continue
    if (value.category === "status") next.status.push(value.id)
    else if (value.category === "workspace") next.workspaces.push(value.id)
    else if (value.category === "adapter") next.adapters.push(value.id)
  }
  setState(next)
}

async function runSearchInput(
  state: SessionFilterState,
  setState: (next: SessionFilterState) => void,
): Promise<void> {
  const value = await vscode.window.showInputBox({
    prompt: "Search sessions by label, command, cwd, or id",
    placeHolder: "Type to search — leave empty to clear",
    value: state.search,
  })
  if (value === undefined) return
  setState({ ...state, search: value })
}
