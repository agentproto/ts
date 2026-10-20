/**
 * Shared "adapters unavailable" announcer for the surfaces that degrade
 * gracefully when a harness listing fails. A FAILED listing (truncated
 * `adapter_list` stub, unreachable daemon, old daemon) must never read as
 * "no adapters installed" — the failure is announced to the user at most
 * once per distinct error, so refresh loops don't spam.
 */

import * as vscode from "vscode"

export function makeAdaptersErrorWarner(subject: string): (error: string | undefined) => void {
  let last: string | undefined
  return error => {
    const changed = error !== last
    last = error
    if (error && changed) {
      void vscode.window.showWarningMessage(`agentproto: ${subject} — ${error}`)
    }
  }
}
