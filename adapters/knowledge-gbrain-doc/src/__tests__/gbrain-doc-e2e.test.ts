/**
 * Live e2e proof — the PR-5 bonus gate. Drives the REAL adapter (HTTP JSON-RPC
 * against a running gbrain) through `put_page` → `search` → `get_page` →
 * `delete_page` for a freshly-ingested page. The mocked unit tests
 * (`adapter.test.ts`) are the required CI gate; this is the live confirmation.
 *
 * Guarded to run ONLY when a gbrain HTTP endpoint is reachable AND a bearer
 * token can be obtained — so CI (or any host without the container) skips it
 * gracefully, mirroring how the code-brain gbrain adapter guards its
 * `docker exec` e2e on container reachability.
 *
 * Token acquisition (in order): `GBRAIN_BEARER_TOKEN` from the env, else mint
 * one via gbrain's OAuth 2.1 DCR + client_credentials flow using the admin
 * bootstrap token (`GBRAIN_ADMIN_BOOTSTRAP_TOKEN`, or read from the running
 * `gbrain-pg` container). Any failure ⇒ the suite skips.
 */

import { execFileSync } from "node:child_process"
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { GbrainDocKnowledgeAdapter } from "../adapter.js"

const ENDPOINT = process.env.GBRAIN_ENDPOINT ?? "http://127.0.0.1:3132"

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${ENDPOINT}/health`, { method: "GET" })
    return res.ok
  } catch {
    return false
  }
}

function bootstrapToken(): string | null {
  const fromEnv = process.env.GBRAIN_ADMIN_BOOTSTRAP_TOKEN
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv
  try {
    const out = execFileSync(
      "docker",
      ["exec", "gbrain-pg", "printenv", "GBRAIN_ADMIN_BOOTSTRAP_TOKEN"],
      { timeout: 10_000, encoding: "utf8" },
    ).trim()
    return out === "" ? null : out
  } catch {
    return null
  }
}

/** Obtain a machine bearer token for the gbrain `/mcp` endpoint. */
async function resolveToken(): Promise<string | null> {
  const fromEnv = process.env.GBRAIN_BEARER_TOKEN
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv
  const admin = bootstrapToken()
  if (admin === null) return null
  try {
    const reg = await fetch(`${ENDPOINT}/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${admin}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_name: "agentproto-kb-gbrain-doc-e2e",
        grant_types: ["client_credentials"],
        token_endpoint_auth_method: "client_secret_post",
        redirect_uris: [],
        scope: "read write",
      }),
    })
    if (!reg.ok) return null
    const client = clientCreds(await reg.json())
    if (client === null) return null
    const tok = await fetch(`${ENDPOINT}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: client.id,
        client_secret: client.secret,
        scope: "read write",
      }).toString(),
    })
    if (!tok.ok) return null
    return accessToken(await tok.json())
  } catch {
    return null
  }
}

function clientCreds(raw: unknown): { id: string; secret: string } | null {
  if (typeof raw !== "object" || raw === null) return null
  const rec: Record<string, unknown> = { ...raw }
  const id = rec.client_id
  const secret = rec.client_secret
  if (typeof id !== "string" || typeof secret !== "string") return null
  return { id, secret }
}

function accessToken(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null
  const rec: Record<string, unknown> = { ...raw }
  return typeof rec.access_token === "string" ? rec.access_token : null
}

const REACHABLE = await reachable()
const TOKEN = REACHABLE ? await resolveToken() : null
const RUN = REACHABLE && TOKEN !== null

// A unique-enough slug without Date.now()/Math.random (both fine in a test, but
// keep it deterministic-ish per run via the pid + hrtime).
const SLUG = `agentproto-gbrain-doc-e2e-${process.pid}-${Math.floor(process.hrtime()[1] / 1000)}`
const TITLE = "Agentproto Gbrain Doc E2E"
const MARKER = "quokka lattice syzygy fjord"

describe.skipIf(!RUN)("gbrain-doc e2e vs live gbrain (put_page → search)", () => {
  const adapter = new GbrainDocKnowledgeAdapter({
    endpoint: ENDPOINT,
    bearerToken: TOKEN ?? "",
    timeoutMs: 30_000,
  })

  // The gbrain slug the adapter actually writes (derived from the title) —
  // captured from the ingest result so the round-trip asserts against the real
  // page id, not the uri-embedded SLUG.
  let ingestedId = ""

  beforeAll(async () => {
    const source = await adapter.ingest({
      kind: "text",
      uri: `doc://${SLUG}`,
      title: `${TITLE} ${SLUG}`,
      content: `---\ntitle: ${TITLE}\ntype: note\n---\n\nThis e2e proves the agentproto gbrain-doc adapter round-trips put_page and search. Marker phrase: ${MARKER}.`,
    })
    ingestedId = source.id
  })

  afterAll(async () => {
    if (ingestedId) await adapter.deleteSource(ingestedId).catch(() => undefined)
  })

  it(
    "healthCheck reports the endpoint reachable",
    async () => {
      expect(await adapter.healthCheck()).toBe(true)
    },
    30_000,
  )

  it(
    "search finds the ingested page by its marker phrase",
    async () => {
      // gbrain indexes a freshly-written page ASYNCHRONOUSLY (put_page queues a
      // backstop job), so the search vector lags the write by a beat — poll
      // until the page surfaces rather than asserting on a single immediate
      // call. This is a real property of the backend, not test flakiness.
      let result = await adapter.query({ query: MARKER, topK: 5 })
      let hit = result.hits.find((h) => h.sourceId === ingestedId)
      for (let attempt = 0; attempt < 15 && hit === undefined; attempt++) {
        await sleep(1000)
        result = await adapter.query({ query: MARKER, topK: 5 })
        hit = result.hits.find((h) => h.sourceId === ingestedId)
      }
      expect(result.engine).toBe("gbrain-doc")
      expect(result.modeUsed).toBe("hybrid")
      expect(hit).toBeDefined()
      expect(hit!.text).toContain(MARKER)
      expect(hit!.score).toBeGreaterThan(0)
    },
    30_000,
  )

  it(
    "getSource round-trips the ingested page",
    async () => {
      const source = await adapter.getSource(ingestedId)
      expect(source).not.toBeNull()
      expect(source!.id).toBe(ingestedId)
      expect(source!.title).toContain(TITLE)
      expect(source!.bytes).toBeGreaterThan(0)
    },
    30_000,
  )

  it(
    "getSource returns null for a page that does not exist",
    async () => {
      expect(await adapter.getSource(`${SLUG}-nope`)).toBeNull()
    },
    30_000,
  )
})
