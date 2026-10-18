/**
 * Parse the canonical `@agentproto-bot` footer (see pr-provenance.ts buildFooter)
 * back into a PrProvenance. Only a rendered footer counts: a `<sub>` line
 * containing the marker. A PR body that merely mentions the marker in prose
 * does NOT count (same rule as hasProvenanceFooter in pr-provenance.ts).
 *
 * Rounding: tokens render through fmtTokens, which collapses >=1000 to one
 * decimal of thousands (12345 -> "12.3k"), so parsing returns 12300, not
 * 12345. Counts below 1000 round-trip exactly. "?" parses as undefined.
 *
 * Known ambiguity: an engine segment without " / " (adapter set, authMode
 * missing) and a bare authMode (session without adapter) render identically;
 * a lone token is read as the adapter.
 */

import { MARKER } from "@agentproto/runtime/pr-provenance"
import type { PrProvenance } from "./types.js"

const parseTokenValue = (s: string): number | undefined => {
  const k = /^(\d+(?:\.\d+)?)k$/.exec(s)
  if (k) return Math.round(Number(k[1]) * 1000)
  return /^\d+$/.test(s) ? parseInt(s, 10) : undefined
}

const TOKENS_RE = /^(\S+) in \/ (\S+) out$/
const COST_RE = /^\$(\d+(?:\.\d+)?)(?: \(([^)]+)\))?$/
const RUN_RE = /^run \[([^\]]*)\]\(([^)]*)\)$/

export const isProvenanceBody = (body: string): boolean =>
  new RegExp(`<sub>[^\\n]*${MARKER}`).test(body)

const extractFooterLine = (body: string): string | undefined => {
  const m = new RegExp(`<sub>([^\\n]*${MARKER}[^\\n]*?)(?:</sub>|$)`, "m").exec(body)
  return m?.[1]
}

const backticked = (seg: string | undefined, prefix: string): string | undefined => {
  if (!seg || !seg.startsWith(`${prefix} \``)) return undefined
  return /`([^`]*)`/.exec(seg.slice(prefix.length))?.[1]
}

export function parseFooter(body: string): PrProvenance | undefined {
  const line = extractFooterLine(body)
  if (line === undefined) return undefined

  const segs = line.split(" · ")
  const prov: PrProvenance = {}
  let i = 0

  const head = /\*\*\s*—\s*(.*)$/.exec(segs[i] ?? "")
  const kind = head?.[1]?.trim()
  if (kind) prov.kind = kind
  i++

  const sessionSeg = segs[i]
  if (sessionSeg?.startsWith("session `")) {
    const m = /^session `([^`]+)`(?: \(`([^`]*)`\))?$/.exec(sessionSeg)
    if (m?.[1]) {
      prov.sessionId = m[1]
      if (m[2]) prov.label = m[2]
    }
    i++
  }

  const isEngine = (seg: string | undefined): seg is string =>
    !!seg &&
    !seg.includes("`") &&
    !TOKENS_RE.test(seg) &&
    !COST_RE.test(seg) &&
    !seg.startsWith("run [")
  const seg = segs[i]
  if (isEngine(seg)) {
    const legacy = /^legacy fallback(?: \(([^)]+)\))?$/.exec(seg)
    if (legacy) {
      if (legacy[1]) prov.authMode = legacy[1]
    } else {
      const [adapter, authMode] = seg.split(" / ")
      if (adapter) prov.adapter = adapter
      if (authMode) prov.authMode = authMode
    }
    i++
  }

  const take = (prefix: string, key: keyof PrProvenance): void => {
    const v = backticked(segs[i], prefix)
    if (v !== undefined) {
      ;(prov as Record<string, unknown>)[key] = v
      i++
    }
  }
  take("auth-profile", "authProfile")
  take("model", "model")
  take("e2b", "sandboxId")
  take("supervisor", "parentSessionId")

  const tok = TOKENS_RE.exec(segs[i] ?? "")
  if (tok) {
    prov.tokensIn = parseTokenValue(tok[1] ?? "")
    prov.tokensOut = parseTokenValue(tok[2] ?? "")
    i++
  }

  const cost = COST_RE.exec(segs[i] ?? "")
  if (cost) {
    prov.costUsd = Number(cost[1])
    if (cost[2]) prov.costSource = cost[2]
    i++
  }

  const run = RUN_RE.exec(segs[i] ?? "")
  if (run) {
    prov.runId = run[1]
    if (run[2]) prov.runUrl = run[2]
    i++
  } else {
    take("host", "host")
    take("cwd", "cwdLabel")
  }
  take("sha", "sha")
  return prov
}
