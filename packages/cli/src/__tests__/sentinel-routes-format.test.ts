/**
 * Text output of `agentproto sentinel routes [explain]`: the router's pick,
 * the provider actually in use, and every provider walked.
 */

import { describe, expect, it } from "vitest"
import type { SentinelRouteExplanation, SentinelRoutesListing } from "@agentproto/sentinel"

import { formatRouteExplanation, formatRoutesListing } from "../commands/sentinel.js"

const NOTE = "shadow only"

describe("agentproto sentinel routes output", () => {
  it("explain for a github subject shows the builtin rule, the routed provider and the legacy one in use", () => {
    const e: SentinelRouteExplanation = {
      subject: "github:agentproto/ts#1501",
      site: "watch",
      slug: "local-gh",
      rule: "builtin:github",
      reason: "no config rule matched; builtin:github (github:*), via local-gh",
      walked: [{ provider: "local-gh", durable: false }],
      do: "deliver",
      fallback: "next-ready",
      ruleMode: "shadow",
      applied: false,
      legacy: "agentpush",
      note: NOTE,
    }
    expect(formatRouteExplanation(e)).toBe(
      "subject  github:agentproto/ts#1501 (site watch)\n" +
        "rule     builtin:github\n" +
        "routed   local-gh\n" +
        "reason   no config rule matched; builtin:github (github:*), via local-gh\n" +
        "in use   agentpush (legacy selection, applied: false)\n" +
        "walked\n" +
        "  local-gh      eligible  durable=false\n",
    )
  })

  it("explain for a session subject shows builtin:session on the session provider", () => {
    const out = formatRouteExplanation({
      subject: "session:sess_child",
      site: "watch",
      slug: "session",
      rule: "builtin:session",
      reason: "no config rule matched; builtin:session (session:*), via session",
      walked: [{ provider: "session" }],
      do: "deliver",
      fallback: "next-ready",
      ruleMode: "shadow",
      applied: false,
      legacy: "session",
      note: NOTE,
    })
    expect(out).toContain("rule     builtin:session\n")
    expect(out).toContain("routed   session\n")
    expect(out).toContain("in use   session (legacy selection, applied: false)\n")
  })

  it("explain for a refused route says none and names the rejection", () => {
    const out = formatRouteExplanation({
      subject: "telegram:x",
      site: "watch",
      slug: null,
      rule: "telegram",
      reason: 'config rule "telegram" matched telegram:*; agentpush unready: no key (fallback: refuse)',
      walked: [{ provider: "agentpush", rejected: "unready: no key", durable: true }],
      do: "deliver",
      fallback: "refuse",
      ruleMode: "shadow",
      applied: false,
      error: "route_unavailable",
      legacy: "local-gh",
      note: NOTE,
    })
    expect(out).toContain("routed   none (route_unavailable)\n")
    expect(out).toContain("  agentpush     rejected: unready: no key  durable=true\n")
  })

  it("list prints config and builtin rows, provider readiness and warnings", () => {
    const listing: SentinelRoutesListing = {
      mode: "shadow",
      configuredMode: "enforce",
      applied: false,
      note: NOTE,
      routes: [
        { id: "gh-default", match: { subject: "github:*" }, via: ["local-gh"], fallback: "refuse", do: "deliver", mode: "enforce", source: "config" },
        { id: "builtin:default", match: { subject: "*" }, via: ["agentpush"], fallback: "refuse", do: "deliver", source: "builtin" },
      ],
      providers: [{ slug: "agentpush", ready: false, reason: "unready: no key", subjects: ["*"], durable: true }],
      warnings: ['route "x": duplicate id'],
    }
    const out = formatRoutesListing(listing)
    expect(out).toContain("mode     shadow (configured: enforce, applied: false)\n")
    expect(out).toMatch(/gh-default\s+github:\*\s+local-gh\s+refuse\s+deliver\s+enforce\n/)
    expect(out).toMatch(/builtin:default\s+\*\s+agentpush\s+refuse\s+deliver\s+builtin\n/)
    expect(out).toMatch(/agentpush\s+no\s+\*\s+unready: no key\n/)
    expect(out).toContain('warning  route "x": duplicate id\n')
  })
})
