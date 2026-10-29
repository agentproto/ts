/**
 * Ref-key extraction, shared with the same convention `buildMastraAgent`
 * uses (`packages/bridge/src/build-agent.ts` `refKey`). An AIP-54 ref is
 * a string shorthand or `{ ref | file | inline }`; the key is the string,
 * else `.ref`, else `.file`, else a stable JSON of the inline payload. A
 * structured `{ kind: mcp, server }` tool item keys as `mcp:<server>`.
 */

import type { AnyRef, McpToolRef } from "@agentproto/agent"

export function refKey(ref: AnyRef | McpToolRef): string {
  if (typeof ref === "string") return ref
  if ("kind" in ref) return `mcp:${ref.server}`
  return ref.ref ?? ref.file ?? JSON.stringify(ref.inline ?? ref)
}

/** `@agentik/writer` → `writer`; bare ids untouched. */
export function stripOwner(id: string): string {
  const m = id.match(/^@[^/]+\/(.+)$/)
  return m ? m[1]! : id
}
