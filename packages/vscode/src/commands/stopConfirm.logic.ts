/**
 * Pure decision logic for the stop-session confirmation modal. No `vscode`
 * import so this is directly unit-testable; sessionActions.ts's
 * killSessionCommand calls into it.
 *
 * VS Code hands back the exact button label the user clicked, or `undefined`
 * for Escape / the implicit modal Cancel button. `undefined` and any label
 * this module doesn't recognise MUST fall to `{stop: false, silence: false}`
 * — the failure mode that matters here isn't "asked once too often", it's
 * "dismissed a dialog and the session died anyway, or the confirm turned
 * itself off without asking".
 */

export const STOP_BUTTON = "Stop"
export const STOP_AND_SILENCE_BUTTON = "Stop and don't ask again"

export interface StopDecision {
  stop: boolean
  silence: boolean
}

export function interpretStopChoice(choice: string | undefined): StopDecision {
  switch (choice) {
    case STOP_AND_SILENCE_BUTTON:
      return { stop: true, silence: true }
    case STOP_BUTTON:
      return { stop: true, silence: false }
    default:
      return { stop: false, silence: false }
  }
}
