/**
 * Tests for the daemon-served stage board (`src/stageboard/`):
 * the pure `toRows` fold (snapshot + ledger events → board rows, exercised
 * at node level with no DOM) and the `GET /agentproto/stageboard.js` route
 * served by `app serve` / `app dev` (exercised over a real loopback HTTP
 * server so the `content-type: text/javascript` contract is asserted
 * end-to-end).
 */

import { describe, it, expect, afterAll } from "vitest"
import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"

import { toRows, unwrapToolResult } from "../stageboard/stageboard.js"
import { STAGEBOARD_JS_PATH, serveStageboard } from "../stageboard/serve.js"
import { bindBridgeServer } from "../app-dev.js"

function ev(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "01HXXXXXXXXXXXXXXXXXXXXXXX",
    ts: "2026-01-01T00:00:00.000Z",
    stage: "s1",
    kind: "stage-started",
    by: "runner",
    payload: {},
    ...overrides,
  }
}

describe("toRows", () => {
  it("returns empty columns/rows for an empty ledger", () => {
    const out = toRows({ stages: {} }, [])
    expect(out.columns).toEqual([])
    expect(out.rows).toEqual([])
    expect(toRows(undefined, undefined).rows).toEqual([])
  })

  it("builds one column per stage (first-seen order) and one row per item", () => {
    const snapshot = {
      stages: {
        draft: { status: "done", items: { "b1:c1": { status: "done" }, "b1:c2": { status: "running" } } },
        review: { status: "running", items: { "b1:c1": { status: "gated-failed" }, "b1:c2": { status: "pending" } } },
      },
    }
    const out = toRows(snapshot, [])
    expect(out.columns).toEqual(["draft", "review"])
    expect(out.rows).toHaveLength(2)
    expect(out.rows[0]?.item).toBe("b1:c1")
    expect(out.rows[0]?.cells).toEqual({ draft: "done", review: "gated-failed" })
    expect(out.rows[1]?.item).toBe("b1:c2")
    expect(out.rows[1]?.cells).toEqual({ draft: "running", review: "pending" })
  })

  it("renders a single stage-level row when the ledger never used items", () => {
    const snapshot = { stages: { build: { status: "running" } } }
    const out = toRows(snapshot, [])
    expect(out.columns).toEqual(["build"])
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]?.item).toBe(null)
    expect(out.rows[0]?.cells).toEqual({ build: "running" })
  })

  it("gated-failed then done: events carry the last gate report and attempts", () => {
    const snapshot = { stages: { verify: { status: "done", items: { ch1: { status: "done" } } } } }
    const events = [
      ev({ kind: "gate-report", item: "ch1", payload: { ok: false, exitCode: 2, report: { findings: ["boom"] } } }),
      ev({ kind: "gate-report", item: "ch1", appRunId: "run-9", payload: { ok: true, exitCode: 0 } }),
    ]
    const out = toRows(snapshot, events)
    const row = out.rows[0]
    expect(row?.cells).toEqual({ verify: "done" })
    expect(row?.attempts).toBe(2)
    expect(row?.appRunId).toBe("run-9")
    expect(row?.lastGate?.ok).toBe(true)
    expect(row?.lastGate?.exitCode).toBe(0)
    expect(row?.lastGate?.findings).toEqual({ ok: true, exitCode: 0 })
  })

  it("uses payload.report.findings for findings when present, else the raw payload", () => {
    const snapshot = { stages: { g: { status: "gated-failed" } } }
    const events = [
      ev({
        kind: "gate-report",
        payload: { ok: false, exitCode: 1, report: { findings: ["a", "b"], summary: { bad: 2 } } },
      }),
    ]
    const out = toRows(snapshot, events)
    expect(out.rows[0]?.lastGate?.findings).toEqual(["a", "b"])

    const raw = toRows({ stages: { g2: { status: "gated-failed" } } }, [
      ev({ stage: "g2", kind: "gate-report", payload: { ok: false, exitCode: 3 } }),
    ])
    expect(raw.rows[0]?.lastGate?.findings).toEqual({ ok: false, exitCode: 3 })
  })

  it("marks an approval event's row approved via the folded snapshot status", () => {
    const snapshot = { stages: { ship: { status: "approved", items: { ch1: { status: "approved" } } } } }
    const events = [ev({ kind: "approval", item: "ch1", payload: { approved: true, who: "jeremy" } })]
    const out = toRows(snapshot, events)
    expect(out.rows[0]?.cells).toEqual({ ship: "approved" })
  })

  it("ignores malformed events and does not create item rows on an item-less ledger", () => {
    const out = toRows({ stages: { a: { status: "done" } } }, [null, "nope", ev({ item: "ghost" })])
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]?.item).toBe(null)
    expect(out.rows[0]?.attempts).toBe(0)
  })
})

describe("unwrapToolResult", () => {
  it("unwraps a CallToolResult text payload and parses JSON text", () => {
    const result = { content: [{ type: "text", text: '{"snapshot":{"stages":{}},"events":[]}' }] }
    expect(unwrapToolResult(result)).toEqual({ snapshot: { stages: {} }, events: [] })
  })

  it("returns non-JSON text as-is", () => {
    expect(unwrapToolResult({ content: [{ text: "plain" }] })).toBe("plain")
  })
})

const servers: Server[] = []

afterAll(async () => {
  await Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve())
        }),
    ),
  )
})

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    servers.push(server)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      resolve(addr && typeof addr === "object" ? addr.port : 0)
    })
  })
}

describe("stageboard route", () => {
  it("serves the ES module as text/javascript with no-store caching", async () => {
    const port = await listen((req, res) => {
      void serveStageboard(res, (req.url ?? "/").split("?")[0] ?? "/")
    })
    const res = await fetch(`http://127.0.0.1:${port}${STAGEBOARD_JS_PATH}`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/javascript")
    expect(res.headers.get("cache-control")).toBe("no-store")
    const body = await res.text()
    expect(body).toContain("export function toRows")
    expect(body).toContain("export function mountStageBoard")
  })

  it("returns false for other paths so the caller falls through", async () => {
    let fellThrough = false
    const port = await listen((req, res) => {
      void serveStageboard(res, (req.url ?? "/").split("?")[0] ?? "/").then((handled) => {
        if (!handled) {
          fellThrough = true
          res.writeHead(404)
          res.end()
        }
      })
    })
    const res = await fetch(`http://127.0.0.1:${port}/ui/index.html`)
    expect(res.status).toBe(404)
    expect(fellThrough).toBe(true)
  })

  it("app dev's bridge server also serves the route (GET, no client needed)", async () => {
    const getClient = () => Promise.reject(new Error("no daemon needed for a static asset"))
    const bridge = await bindBridgeServer(0, getClient)
    try {
      const res = await fetch(`http://127.0.0.1:${bridge.port}${STAGEBOARD_JS_PATH}`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/javascript")
      expect(await res.text()).toContain("mountStageBoard")
    } finally {
      await bridge.close()
    }
  })
})
