/**
 * A network-level failure between the harness and the provider (a one-off TLS
 * handshake failure, a reset or timed-out socket, a transient DNS miss) is
 * transient, not a bad request. Observed 2026-11-04 on two opencode executors
 * (`opencode-go/deepseek-v4.1-flash`): opencode logged
 *
 *   level=ERROR message="stream error" providerID=opencode-go ...
 *     error.error="TypeError: EPROTO: The TLS handshake failed. Does the server speak TLS on this port?"
 *
 * the harness surfaced it as the turn's error (`parseStderrStreamError` strips
 * the `TypeError:` prefix), and turn retry skipped it as "not a transient
 * provider error", so both sessions stopped mid-work.
 */

import { describe, it, expect } from "vitest"
import type { SessionDescriptor } from "../sessions.js"
import { classifyTurnError, computeTurnRetryDelayMs, decideTurnRetry, emptyTurnWarningLine } from "../turn-retry.js"
import { resolveTurnRetryPolicy } from "../turn-retry-policy.js"

/** What `parseStderrStreamError` hands the registry for the observed line. */
const TLS_HANDSHAKE = "EPROTO: The TLS handshake failed. Does the server speak TLS on this port?"
/** The raw `error.error` value, for a path that keeps the class prefix. */
const TLS_HANDSHAKE_RAW = `TypeError: ${TLS_HANDSHAKE}`

const policy = resolveTurnRetryPolicy({ on: ["rate-limit", "upstream-5xx", "no-output-stall"] })
const desc = { id: "s", kind: "agent-cli", status: "running", turnRetry: policy } as SessionDescriptor
const errEnd = (error: string) => ({ kind: "turn-end" as const, reason: "error", error })

describe("network-level failures → transient", () => {
  it.each([TLS_HANDSHAKE, TLS_HANDSHAKE_RAW])("classifies the observed TLS failure as upstream-5xx: %s", m => {
    expect(classifyTurnError(m)).toBe("upstream-5xx")
  })

  it.each([
    "read ECONNRESET",
    "TypeError: fetch failed: ECONNRESET: socket closed",
    "connect ETIMEDOUT 104.18.2.3:443",
    "write EPIPE",
    "getaddrinfo EAI_AGAIN opencode.ai",
    "socket hang up",
    "Client network socket disconnected before secure TLS connection was established",
    "TLS handshake timeout",
    "SocketError: other side closed (UND_ERR_SOCKET)",
    "Connect Timeout Error (UND_ERR_CONNECT_TIMEOUT)",
    "Connection reset by peer",
  ])("%s → upstream-5xx", m => {
    expect(classifyTurnError(m)).toBe("upstream-5xx")
  })

  it("retries the observed failure with the normal backoff", () => {
    expect(decideTurnRetry(desc, errEnd(TLS_HANDSHAKE))).toMatchObject({
      action: "retry",
      errorClass: "upstream-5xx",
      attempt: 1,
      delayMs: computeTurnRetryDelayMs(policy, 0),
    })
  })

  it("backs off on later attempts and stops at maxRetries", () => {
    const second = { ...desc, turnRetryAttempts: 1 } as SessionDescriptor
    expect(decideTurnRetry(second, errEnd(TLS_HANDSHAKE))).toMatchObject({
      action: "retry",
      attempt: 2,
      delayMs: computeTurnRetryDelayMs(policy, 1),
    })
    const spent = { ...desc, turnRetryAttempts: policy.maxRetries } as SessionDescriptor
    expect(decideTurnRetry(spent, errEnd(TLS_HANDSHAKE))).toMatchObject({ action: "exhausted" })
  })

  it.each([
    "getaddrinfo ENOTFOUND api.example.invalid",
    "connect ECONNREFUSED 127.0.0.1:18090",
    "certificate has expired",
    "context length exceeded",
  ])("keeps a non-transient failure non-transient: %s", m => {
    expect(classifyTurnError(m)).toBe("other")
  })

  it("still lets an auth error win over a network word", () => {
    expect(classifyTurnError("401 Unauthorized after ECONNRESET")).toBe("auth")
  })

  it("the empty-turn warning calls it transient", () => {
    const line = emptyTurnWarningLine({ costUsd: 0, errorMessage: TLS_HANDSHAKE })
    expect(line).toContain("transient error (upstream-5xx)")
    expect(line).toContain("EPROTO")
  })
})
