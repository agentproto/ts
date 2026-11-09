/**
 * A link-session token carrying a `browserSessionId` claim reads the
 * screencast routes of THAT browser session (the chrome-live instance the
 * browser tools address), and nothing else. One predicate
 * (`appLinkSessionReadAuth`) backs both the tunnel gate and the route's
 * sessions-token skip, so this table is the single place the rule is pinned.
 */

import { afterEach, describe, expect, it } from "vitest"
import type { IncomingMessage } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { appLinkSessionReadAuth, appLinkTunnelBypass } from "../app-link-gate.js"
import { mintAppLinkSessionToken, resetAppLinkSigningKeyCacheForTests } from "../app-link-token.js"

const APP_ID = "@agentik/session-chat"
const SCREENCAST_SPELLINGS = ["screencast", "screencast.jpg", "screencast.mjpg"]

describe("link read gate: browserSessionId claim", () => {
  let dir: string
  let keyPath: string

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    resetAppLinkSigningKeyCacheForTests()
  })

  async function setup(claims: Record<string, string>): Promise<IncomingMessage> {
    dir = await mkdtemp(join(tmpdir(), "agentproto-link-gate-bs-"))
    keyPath = join(dir, "app_link_hmac")
    const { token } = mintAppLinkSessionToken({ appId: APP_ID, claims: { telegramUserId: "42", ...claims }, ttlMs: 60_000, keyPath })
    return { headers: { authorization: `Bearer ${token}` }, url: "/", socket: { remoteAddress: "203.0.113.7" } } as unknown as IncomingMessage
  }

  it("grants the three screencast spellings of the named browser session, GET only", async () => {
    const req = await setup({ browserSessionId: "sess_b1" })
    for (const s of SCREENCAST_SPELLINGS) {
      expect(appLinkSessionReadAuth(req, `/sessions/sess_b1/${s}`, "GET", keyPath)?.appId).toBe(APP_ID)
      expect(appLinkTunnelBypass(req, `/sessions/sess_b1/${s}`, "GET", keyPath)).toBe(true)
      expect(appLinkSessionReadAuth(req, `/sessions/sess_b1/${s}`, "POST", keyPath)).toBeUndefined()
      expect(appLinkTunnelBypass(req, `/sessions/sess_b1/${s}`, "POST", keyPath)).toBe(false)
    }
  })

  it("refuses another browser session, every other /sessions read, and unknown spellings", async () => {
    const req = await setup({ browserSessionId: "sess_b1" })
    for (const s of SCREENCAST_SPELLINGS) {
      expect(appLinkSessionReadAuth(req, `/sessions/sess_b2/${s}`, "GET", keyPath)).toBeUndefined()
    }
    for (const p of [
      "/sessions/sess_b1",
      "/sessions/sess_b1/events",
      "/sessions/sess_b1/events/stream",
      "/sessions/sess_b1/capabilities",
      "/sessions/sess_b1/stream",
      "/sessions/sess_b1/screencast.png",
      "/sessions/sess_b1/screencast/extra",
    ]) {
      expect(appLinkSessionReadAuth(req, p, "GET", keyPath), p).toBeUndefined()
      expect(appLinkTunnelBypass(req, p, "GET", keyPath), p).toBe(false)
    }
  })

  it("does not unlock the non-screencast reads of a session named only through browserSessionId, even when sessionId differs", async () => {
    const req = await setup({ sessionId: "sess_a1", browserSessionId: "sess_b1" })
    expect(appLinkSessionReadAuth(req, "/sessions/sess_b1/events", "GET", keyPath)).toBeUndefined()
    expect(appLinkSessionReadAuth(req, "/sessions/sess_b1", "GET", keyPath)).toBeUndefined()
    expect(appLinkSessionReadAuth(req, "/sessions/sess_b1/screencast.jpg", "GET", keyPath)).toBeDefined()
  })

  it("keeps every existing read of the own sessionId when both claims are present", async () => {
    const req = await setup({ sessionId: "sess_a1", browserSessionId: "sess_b1" })
    for (const s of ["", "/events", "/events/stream", "/capabilities", "/screencast", "/screencast.jpg", "/screencast.mjpg"]) {
      expect(appLinkSessionReadAuth(req, `/sessions/sess_a1${s}`, "GET", keyPath), s).toBeDefined()
    }
    expect(appLinkSessionReadAuth(req, "/sessions/sess_a2/events", "GET", keyPath)).toBeUndefined()
    expect(appLinkSessionReadAuth(req, "/sessions/sess_a2/screencast.jpg", "GET", keyPath)).toBeUndefined()
  })

  it("a token without the claim reads no foreign screencast", async () => {
    const req = await setup({ approvalId: "a1" })
    for (const s of SCREENCAST_SPELLINGS) {
      expect(appLinkSessionReadAuth(req, `/sessions/sess_b1/${s}`, "GET", keyPath)).toBeUndefined()
    }
  })
})
