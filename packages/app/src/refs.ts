/**
 * Ref-key extraction, shared with the same convention `buildMastraAgent`
 * uses (`packages/mastra/src/build-agent.ts` `refKey`). An AIP-27 ref is
 * a string shorthand or `{ ref | file | inline }`; the key is the string,
 * else `.ref`, else `.file`, else a stable JSON of the inline payload.
 */

import type { AnyRef } from "@agentproto/agent"

export function refKey(ref: AnyRef): string {
  if (typeof ref === "string") return ref
  return ref.ref ?? ref.file ?? JSON.stringify(ref.inline ?? ref)
}

/** `@agentik/writer` → `writer`; bare ids untouched. */
export function stripOwner(id: string): string {
  const m = id.match(/^@[^/]+\/(.+)$/)
  return m ? m[1]! : id
}
