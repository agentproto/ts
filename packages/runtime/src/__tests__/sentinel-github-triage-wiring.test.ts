import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import {
  BUILTIN_SENTINEL_PROVIDERS,
  createFakeSentinelProvider,
  makeFakeEvent,
  type FakeSentinelProvider,
} from "@agentproto/sentinel"

import { createGateway, type GatewayHandle } from "../index.js"

const SLUG = "test-github-triage-push"
const HOOK_KEY = "test-github-triage-hook"
const TARGET = "test-github-triage-target"

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function makePushProvider(): FakeSentinelProvider {
  const fake = createFakeSentinelProvider({ slug: SLUG })
  return {
    ...fake,
    async create(spec, delivery) {
      const handle = await fake.create(spec, delivery)
      return { ...handle, state: { ...(handle.state ?? {}), hookKey: HOOK_KEY } }
    },
    async attach(handle, delivery) {
      const attached = await fake.attach(handle, delivery)
      return { ...attached, state: { ...(attached.state ?? {}), hookKey: HOOK_KEY } }
    },
    parseInbound(req) {
      const input = JSON.parse(req.rawBody) as { id: string; conclusion: string }
      return {
        ok: true,
        events: [
          makeFakeEvent({
            id: input.id,
            type: "github.check_suite.completed",
            subject: "github:o/r#1",
            summary: `check suite ${input.conclusion}`,
            data: { headSha: "sha1", conclusion: input.conclusion },
          }),
        ],
      }
    },
    defaultTypes() {
      return ["github.check_suite.completed"]
    },
  }
}

describe("daemon sentinel runtime GitHub triage wiring", () => {
  const previousHome = process.env.AGENTPROTO_HOME
  let home: string
  let workspace: string
  let gateway: GatewayHandle | undefined

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "agentproto-github-triage-home-"))
    workspace = mkdtempSync(join(tmpdir(), "agentproto-github-triage-ws-"))
    process.env.AGENTPROTO_HOME = home
    BUILTIN_SENTINEL_PROVIDERS[SLUG] = () => makePushProvider()

    gateway = await createGateway({
      workspace,
      specs: [],
      port: await freePort(),
      boot: false,
      persist: false,
      persistPath: join(workspace, "sessions.json"),
    })
    gateway.sessions.touchExternal({ id: TARGET, host: "test", name: "triage target" })
  })

  afterEach(async () => {
    delete BUILTIN_SENTINEL_PROVIDERS[SLUG]
    await gateway?.stop().catch(() => undefined)
    gateway = undefined
    if (previousHome === undefined) delete process.env.AGENTPROTO_HOME
    else process.env.AGENTPROTO_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  })

  it("classifies check_suite failure as wake and success as fyi without test registration", async () => {
    const gw = gateway!
    const create = await fetch(`${gw.url}/sentinels`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${gw.token}` },
      body: JSON.stringify({
        subject: "github:o/r#1",
        types: ["github.check_suite.completed"],
        sessionId: TARGET,
        urgency: "next-turn",
        provider: SLUG,
        until: "never",
      }),
    })
    expect(create.status).toBe(201)

    for (const [id, conclusion] of [
      ["evt-failure", "failure"],
      ["evt-success", "success"],
    ] as const) {
      const delivered = await fetch(`${gw.url}/inbound/sentinel-${HOOK_KEY}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, conclusion }),
      })
      expect(delivered.status).toBe(200)
    }

    const ledger = readFileSync(join(home, "delivery-ledger.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line) as { eventId: string; level: number; rule: string })

    expect(ledger.find(line => line.eventId === "evt-failure")).toMatchObject({
      level: 2,
      rule: "failure",
    })
    expect(ledger.find(line => line.eventId === "evt-success")).toMatchObject({
      level: 1,
      rule: "github-triage-table:check-suite-success",
    })
  })
})
