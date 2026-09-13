/**
 * @agentproto/transcript-fixtures — canonical RAW daemon-transcript fixtures.
 *
 * The single source of truth (producer) for the RAW `{seq, ts, kind, ...}`
 * records the daemon's transcript writer emits. Consumed as anti-drift
 * conformity data by:
 *   - `packages/runtime` test suites (this repo) — e.g. the future
 *     `/sessions/:id/chat` route;
 *   - `packages/react-agentproto`'s `normalize.ts` (the agentik-studio repo,
 *     pulled in as `workspace:*`).
 *
 * Zero runtime dependencies — just typed data.
 */

export {
  CANONICAL_SESSION_ID,
  CANONICAL_SESSION_RECORDS,
  type AgentprotoRawTranscriptRecord,
  type AgentprotoRawTranscriptBase,
  type AgentprotoRawUserPrompt,
  type AgentprotoRawThought,
  type AgentprotoRawTextDelta,
  type AgentprotoRawToolCall,
  type AgentprotoRawToolResult,
  type AgentprotoRawToolCallRecord,
  type AgentprotoRawPermissionResolved,
  type AgentprotoRawTurnEnd,
  type AgentprotoRawNotice,
  type AgentprotoRawUsageUpdate,
  type AgentprotoRawUsageSnapshot,
} from "./records.js"

import { CANONICAL_SESSION_RECORDS } from "./records.js"

/**
 * The canonical fixture as a ready-to-replay JSONL string, assembled from
 * `CANONICAL_SESSION_RECORDS` (one JSON object per line, newline-terminated).
 * Anyone replaying an HTTP/SSE-style stream, or seeding an events.jsonl file,
 * can consume this directly.
 */
export const CANONICAL_SESSION_JSONL: string =
  CANONICAL_SESSION_RECORDS.map(record => JSON.stringify(record)).join("\n") + "\n"