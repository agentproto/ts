/**
 * A >200-char daemon HTTP error body must reach the user intact.
 *
 * Regression test for the 200-char guillotine that used to truncate every
 * daemon HTTP error via `raw.slice(0, 200)` in httpPostJson / httpGetJson /
 * httpDelete — cutting the missing-credentials hint (~300 chars) off
 * mid-word. `formatHttpError` (_daemon-helpers.ts) is now the single place
 * all three call sites route through.
 */

import { createServer } from "node:http"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  formatHttpError,
  httpDelete,
  httpGetJson,
  httpPostJson,
} from "../commands/_daemon-helpers.js"

// Realistic stand-in for the daemon's missing_auth_credential body
// (define-agent-cli.ts:291) — well over the old 200-char cap. No embedded
// double-quotes, so its JSON-encoded form (LONG_JSON_BODY, below) is
// byte-for-byte identical to this raw string — keeps the assertions below
// simple without fighting JSON-escaping of the fixture itself.
const LONG_MESSAGE =
  "agent_start: spawn failed — [missing_auth_credential at opts.auth.credential] " +
  "agent-cli 'claude-code': no billing auth. Subscription → `claude setup-token`. " +
  "Api-key → `agentproto auth provider set anthropic sk-…`. " +
  "Add defaults.adapters.claude-code.auth.mode=api-key " +
  "in ~/.agentproto/config.json. Never inherited from the shell."

const LONG_JSON_BODY = JSON.stringify({
  error: "agent_spawn_failed",
  message: LONG_MESSAGE,
})

describe("formatHttpError", () => {
  it("surfaces a JSON body's message in full, unsliced", () => {
    expect(LONG_JSON_BODY.length).toBeGreaterThan(200)
    const err = formatHttpError(500, LONG_JSON_BODY)
    expect(err.message).toContain(LONG_MESSAGE)
    expect(err.message).not.toContain("[truncated]")
  })

  it("keeps the raw JSON body intact so error-code special-casing still works", () => {
    const err = formatHttpError(500, LONG_JSON_BODY)
    const bodyText = err.message.replace(/^HTTP \d+:\s*/, "")
    expect(JSON.parse(bodyText)).toEqual({
      error: "agent_spawn_failed",
      message: LONG_MESSAGE,
    })
  })

  it("caps a non-JSON body with a visible truncation marker, never mid-word silently", () => {
    const rawBody = "x".repeat(3000)
    const err = formatHttpError(500, rawBody)
    expect(err.message).toContain("…[truncated]")
    expect(err.message.length).toBeLessThan(rawBody.length)
  })

  it("passes a short non-JSON body through unchanged", () => {
    const err = formatHttpError(404, "not found")
    expect(err.message).toBe("HTTP 404: not found")
  })
})

describe("httpPostJson / httpGetJson / httpDelete — error body survives end to end", () => {
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    server = createServer((req, res) => {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(LONG_JSON_BODY)
    })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it("httpPostJson rejects with the full error body", async () => {
    await expect(httpPostJson(baseUrl, {})).rejects.toThrow(LONG_MESSAGE)
  })

  it("httpGetJson rejects with the full error body", async () => {
    await expect(httpGetJson(baseUrl)).rejects.toThrow(LONG_MESSAGE)
  })

  it("httpDelete rejects with the full error body", async () => {
    await expect(httpDelete(baseUrl)).rejects.toThrow(LONG_MESSAGE)
  })
})
