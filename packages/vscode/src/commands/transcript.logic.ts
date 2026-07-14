/**
 * Pure transcript formatting logic. No `vscode` import so this is directly
 * unit-testable; transcript.ts's OutputChannel plumbing calls into these.
 */

import type { SessionDescriptor } from "../client/types.js"

/** OutputChannel name: `agentproto: <label|id>`. */
export function transcriptChannelName(session: Pick<SessionDescriptor, "label" | "id">): string {
  return `agentproto: ${session.label ?? session.id}`
}

/** Split an export/preview text blob into lines for OutputChannel.appendLine, dropping one trailing empty line. */
export function splitTranscriptLines(content: string): string[] {
  const lines = content.split(/\r\n|\r|\n/)
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines
}
