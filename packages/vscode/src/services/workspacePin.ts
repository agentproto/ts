/**
 * Per-window "target workspace" pin — a Memento-backed shell over
 * workspacePin.logic.ts. Persisted in workspaceState so each VS Code window
 * keeps its own pin across reloads, independent of every other window and
 * of the daemon's global `active` workspace.
 */

import * as vscode from "vscode"

import type { WorkspacePin } from "./workspacePin.logic.js"

/** workspaceState key. Bumped only if the value shape changes. */
const PIN_KEY = "agentproto.workspacePin.v1"

export class WorkspacePinStore implements vscode.Disposable {
  private pin: WorkspacePin
  private readonly memento: vscode.Memento
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this._onDidChange.event

  constructor(memento: vscode.Memento) {
    this.memento = memento
    this.pin = memento.get<string>(PIN_KEY) || undefined
  }

  get(): WorkspacePin {
    return this.pin
  }

  async set(pin: WorkspacePin): Promise<void> {
    if (pin === this.pin) return
    this.pin = pin
    await this.memento.update(PIN_KEY, pin)
    this._onDidChange.fire()
  }

  dispose(): void {
    this._onDidChange.dispose()
  }
}
