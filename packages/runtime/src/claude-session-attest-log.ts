/**
 * Debug trail for the Claude Code session attestation (`x-agentproto-claude-session`,
 * see `resolveCallerSessionId` in http-server.ts). One line per DISTINCT outcome,
 * re-emitted at most every `reemitMs`, never per request: stderr is a
 * launchd-redirected file, every line is a synchronous write.
 *
 * Nothing secret is logged: only the first 8 characters of an accepted id, and
 * for a refused header only the reason (never the value).
 */

export type AttestationOutcome =
  | { kind: "resolved"; idPrefix: string; query: string }
  | { kind: "refused"; reason: "invalid_format" | "untrusted_request" | "identity_not_shared"; query: string }
  | { kind: "absent"; query: string }

const ID = /^[A-Za-z0-9._-]{1,128}$/

/** Pure decision for one `/mcp` request. `query` is the `callerSessionId`
 *  claimed in the URL (undefined = none). Returns undefined when the request is
 *  not a candidate (no header and a non-shared identity: nothing to explain). */
export function classifyAttestation(input: {
  header: string | undefined
  query: string | undefined
  shared: string
  trusted: boolean
}): AttestationOutcome | undefined {
  const query = input.query ?? "none"
  const sharedOrNone = input.query === undefined || input.query === input.shared
  const header = input.header?.trim()
  if (!header) return sharedOrNone ? { kind: "absent", query } : undefined
  if (!ID.test(header)) return { kind: "refused", reason: "invalid_format", query }
  if (!sharedOrNone) return { kind: "refused", reason: "identity_not_shared", query }
  if (!input.trusted) return { kind: "refused", reason: "untrusted_request", query }
  return { kind: "resolved", idPrefix: header.slice(0, 8), query }
}

export function formatAttestation(o: AttestationOutcome): string {
  const head = "[mcp] claude-session attestation:"
  switch (o.kind) {
    case "resolved":
      return `${head} header accepted, caller resolved to cc:${o.idPrefix} (url identity: ${o.query})`
    case "refused":
      return `${head} header present but refused (${o.reason}; url identity: ${o.query})`
    case "absent":
      return `${head} no header on a shared/anonymous connection (url identity: ${o.query})`
  }
}

/** Dedupes by outcome (kind, reason, id prefix, url identity); bounded. */
export function createAttestationLogGate(
  write: (line: string) => void,
  opts: { reemitMs?: number; now?: () => number; maxKeys?: number } = {},
): (o: AttestationOutcome | undefined) => void {
  const reemitMs = opts.reemitMs ?? 10 * 60_000
  const now = opts.now ?? Date.now
  const maxKeys = opts.maxKeys ?? 256
  const last = new Map<string, number>()
  return o => {
    if (!o) return
    const key = `${o.kind}|${"reason" in o ? o.reason : ""}|${"idPrefix" in o ? o.idPrefix : ""}|${o.query.slice(0, 40)}`
    const t = now()
    const prev = last.get(key)
    if (prev !== undefined && t - prev < reemitMs) return
    if (prev === undefined && last.size >= maxKeys) last.delete(last.keys().next().value as string)
    last.set(key, t)
    write(formatAttestation(o))
  }
}
