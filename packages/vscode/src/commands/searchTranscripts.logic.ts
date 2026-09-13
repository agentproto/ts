/**
 * Pure hit → QuickPick-item mapping + snippet trimming for
 * agentproto.searchTranscripts — NO vscode import so it's unit-testable
 * under plain vitest, matching commands/transcript.logic.ts's split.
 * searchTranscripts.ts is the thin vscode-importing shell (InputBox /
 * QuickPick / executeCommand) that calls these.
 */

import type { BrainQueryHit } from "../client/daemonClient.js"

/** Trim a snippet to ~`maxLen` chars for a QuickPick `detail` line —
 *  collapses embedded newlines first (a multi-line chunk reads as one
 *  line in the list) then hard-truncates with an ellipsis. */
export function trimSnippet(snippet: string, maxLen = 200): string {
  const collapsed = snippet.replace(/\s+/g, " ").trim()
  if (collapsed.length <= maxLen) return collapsed
  return collapsed.slice(0, maxLen - 1).trimEnd() + "…"
}

export interface SearchTranscriptsPick {
  readonly label: string
  readonly description: string
  readonly detail: string
  /** Index into the original hits array, so the command can resolve the
   *  full hit (sessionId, workspace, …) from the user's QuickPick pick
   *  without re-encoding it into the label/description/detail strings. */
  readonly hitIndex: number
}

/**
 * Map federated `GET /brain/query` hits to QuickPick items.
 *
 * `label` = title, falling back to sessionId, falling back to the raw
 * sourceId (a knowledge-file source may carry neither). `description` =
 * sessionId, with `· <workspace>` appended when the hit's workspace isn't
 * `callerWorkspace` (the caller's OWN workspace, when known) — so a hit
 * from the caller's own bucket doesn't redundantly repeat it, but a hit
 * from anywhere else clearly says where it came from. `detail` = the
 * snippet, trimmed to ~200 chars.
 */
export function hitsToQuickPickItems(
  hits: readonly BrainQueryHit[],
  callerWorkspace?: string,
): SearchTranscriptsPick[] {
  return hits.map((hit, hitIndex) => {
    const label = hit.title ?? hit.sessionId ?? hit.sourceId
    const idPart = hit.sessionId ?? hit.sourceId
    const description =
      callerWorkspace && hit.workspace !== callerWorkspace
        ? `${idPart} · ${hit.workspace}`
        : idPart
    return {
      label,
      description,
      detail: trimSnippet(hit.snippet),
      hitIndex,
    }
  })
}
