/**
 * Shared Ref-parsing helpers used by every governance provider body.
 *
 * The bodies accept AIP-27 `Ref` compact strings on the contract surface
 * and bridge to the legacy string forms the v0.1 runtime helpers
 * (`signArtifact`, `recordAuditEvent`, …) still consume. The bridge
 * goes away when the doctype schemas migrate to native Ref objects (M1.5).
 */

import { defineRef, refMatchesCollection } from "@agentproto/ref"
import { ToolError } from "@agentproto/tool"

export function parseAndAssertCollection(
  refString: string,
  collection: string,
  field: string
): ReturnType<typeof defineRef> {
  let parsed
  try {
    parsed = defineRef(refString)
  } catch (err) {
    throw new ToolError({
      code: "input_invalid",
      message: `${field}: ${(err as Error).message}`,
      cause: err,
    })
  }
  if (!refMatchesCollection(parsed.value, collection)) {
    throw new ToolError({
      code: "input_invalid",
      message: `${field}: ref kind '${parsed.kind}' is not in the '${collection}' collection`,
    })
  }
  return parsed
}

export function legacyArtifactPath(ref: {
  kind: string
  [key: string]: unknown
}): string {
  if (ref.kind === "local" && typeof ref.path === "string") return ref.path
  throw new ToolError({
    code: "input_invalid",
    message: `artifact: only 'local' refs are supported by the v0.1 runtime — got '${ref.kind}'`,
  })
}

export function legacySignerString(ref: {
  kind: string
  [key: string]: unknown
}): string {
  if (ref.kind === "operator" && typeof ref.slug === "string")
    return `operator:${ref.slug}`
  if (ref.kind === "user" && typeof ref.id === "string") return `user:${ref.id}`
  if (ref.kind === "persona" && typeof ref.id === "string")
    return `persona:${ref.id}`
  if (ref.kind === "email" && typeof ref.address === "string")
    return `counterparty:${ref.address}`
  throw new ToolError({
    code: "input_invalid",
    message: `signer: ref kind '${ref.kind}' has no legacy string mapping`,
  })
}

export function parseLegacyIdentity(refString: string, field: string): string {
  const parsed = parseAndAssertCollection(refString, "identity", field)
  return parsed.compact
}
