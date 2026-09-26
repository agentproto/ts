/**
 * `agentproto llm endpoints <list|test>`
 *
 * Read-only visibility into the LLM gateway's named OpenAI-compatible
 * endpoints (local/LAN model servers — Ollama, llama-server, vLLM, …),
 * configured in `~/.agentproto/llm-endpoints.json`
 * (`LLM_ENDPOINT_ENDPOINTS_FILE` overrides the path) — the same file
 * `@agentproto/llm-endpoint` reads at request time to route `<id>/<model>`.
 *
 * `add`/`remove` are deliberately out of scope for now — edit the JSON file
 * directly (see the package README's "Named endpoints" section for its
 * shape). This mirrors how `auth cred`/`auth profile` keep their own JSON
 * stores, but scoped down to what's needed today: seeing what's configured
 * (`list`) and whether it's actually reachable (`test`).
 */

import { parseArgs } from "node:util"
import {
  readEndpointsFromDisk,
  resolveEndpointsFilePath,
  type EndpointConfig,
} from "@agentproto/llm-endpoint"

export async function runLlm(args: readonly string[]): Promise<number> {
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case "endpoints":
      return runLlmEndpoints(rest)
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(USAGE)
      return 0
    default:
      process.stderr.write(`agentproto llm: unknown subcommand '${sub}'.\n\n${USAGE}`)
      return 2
  }
}

const USAGE = `agentproto llm — the LLM gateway's named local/LAN model endpoints

Usage:
  agentproto llm endpoints list [--json]
  agentproto llm endpoints test [--json]

Endpoints live in ~/.agentproto/llm-endpoints.json (LLM_ENDPOINT_ENDPOINTS_FILE
overrides the path) — see the @agentproto/llm-endpoint README's "Named
endpoints" section for the file's shape. Add/remove one by editing that file
directly; \`list\`/\`test\` are read-only.
`

const ENDPOINTS_USAGE = `agentproto llm endpoints — named OpenAI-compatible endpoints

Usage:
  agentproto llm endpoints list [--json]
                          configured endpoints (id, baseUrl, whether its key
                          env var is set) — no network call.
  agentproto llm endpoints test [--json]
                          live reachability + model listing per endpoint (a
                          real GET <baseUrl>/models per entry, 4s timeout).
                          Exit code is 1 if any endpoint is unreachable.
`

async function runLlmEndpoints(args: readonly string[]): Promise<number> {
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case "list":
    case "ls":
      return runEndpointsList(rest)
    case "test":
      return runEndpointsTest(rest)
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(ENDPOINTS_USAGE)
      return 0
    default:
      process.stderr.write(
        `agentproto llm endpoints: unknown subcommand '${sub}'.\n\n${ENDPOINTS_USAGE}`,
      )
      return 2
  }
}

function loadConfiguredOrFail(path: string): EndpointConfig[] | null {
  const { endpoints, errors } = readEndpointsFromDisk(path)
  if (errors.length > 0) {
    process.stderr.write(
      `agentproto llm endpoints: ${path} is invalid:\n` +
        errors.map((e) => `  - ${e}\n`).join(""),
    )
    return null
  }
  return endpoints
}

async function runEndpointsList(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: { json: { type: "boolean" } },
  })
  const path = resolveEndpointsFilePath()
  const endpoints = loadConfiguredOrFail(path)
  if (endpoints === null) return 1

  if (values.json) {
    process.stdout.write(
      JSON.stringify(
        {
          path,
          endpoints: endpoints.map((e) => ({
            id: e.id,
            baseUrl: e.baseUrl,
            apiKeyEnv: e.apiKeyEnv ?? null,
            apiKeySet: e.apiKeyEnv ? Boolean(process.env[e.apiKeyEnv]) : null,
          })),
        },
        null,
        2,
      ) + "\n",
    )
    return 0
  }
  if (endpoints.length === 0) {
    process.stdout.write(
      `agentproto llm endpoints: no endpoints configured in ${path}.\n` +
        `  (forge is separate — it's the implicit FORGE_BASE_URL/FORGE_API_KEY endpoint.)\n`,
    )
    return 0
  }
  process.stdout.write(`Configured endpoints (${path}):\n`)
  for (const e of endpoints) {
    const key = e.apiKeyEnv
      ? `${e.apiKeyEnv} ${process.env[e.apiKeyEnv] ? "(set)" : "(unset — keyless request)"}`
      : "(keyless — no apiKeyEnv)"
    process.stdout.write(`  ${e.id}  ${e.baseUrl}  key: ${key}\n`)
  }
  return 0
}

interface EndpointTestResult {
  id: string
  baseUrl: string
  reachable: boolean
  models: string[]
  latencyMs: number
  detail?: string
}

const ENDPOINT_TEST_TIMEOUT_MS = 4000

/** `{data:[{id}]}` OpenAI-shaped model list → the ids, tolerating anything else. */
function extractModelIds(body: unknown): string[] {
  if (typeof body !== "object" || body === null) return []
  const data = Reflect.get(body, "data")
  if (!Array.isArray(data)) return []
  return data
    .map((m: unknown) =>
      typeof m === "object" && m !== null && typeof Reflect.get(m, "id") === "string"
        ? (Reflect.get(m, "id") as string)
        : null,
    )
    .filter((id): id is string => id !== null)
}

/** The cheapest live probe of one endpoint: GET <baseUrl>/models, time-boxed.
 *  Never throws — a network error / timeout / non-2xx resolves `reachable:false`
 *  with a human-readable `detail`, mirroring the gateway's own GET /v1/endpoints. */
async function testOneEndpoint(endpoint: EndpointConfig): Promise<EndpointTestResult> {
  const key = endpoint.apiKeyEnv ? process.env[endpoint.apiKeyEnv] : undefined
  const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {}
  const start = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ENDPOINT_TEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${endpoint.baseUrl.replace(/\/+$/, "")}/models`, {
      headers,
      signal: controller.signal,
    })
    const latencyMs = Date.now() - start
    if (!res.ok) {
      return { id: endpoint.id, baseUrl: endpoint.baseUrl, reachable: false, models: [], latencyMs, detail: `HTTP ${res.status}` }
    }
    const body: unknown = await res.json().catch(() => null)
    return { id: endpoint.id, baseUrl: endpoint.baseUrl, reachable: true, models: extractModelIds(body), latencyMs }
  } catch (err) {
    return {
      id: endpoint.id,
      baseUrl: endpoint.baseUrl,
      reachable: false,
      models: [],
      latencyMs: Date.now() - start,
      detail: err instanceof Error ? err.message : String(err),
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function runEndpointsTest(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: { json: { type: "boolean" } },
  })
  const path = resolveEndpointsFilePath()
  const endpoints = loadConfiguredOrFail(path)
  if (endpoints === null) return 1
  if (endpoints.length === 0) {
    process.stdout.write(`agentproto llm endpoints: no endpoints configured in ${path}.\n`)
    return 0
  }

  const results = await Promise.all(endpoints.map(testOneEndpoint))
  if (values.json) {
    process.stdout.write(JSON.stringify({ path, results }, null, 2) + "\n")
  } else {
    for (const r of results) {
      const status = r.reachable ? "✓ reachable" : "✗ unreachable"
      const info = r.reachable
        ? `${r.models.length} model(s), ${r.latencyMs}ms`
        : (r.detail ?? "unknown error")
      process.stdout.write(`  ${status}  ${r.id}  ${r.baseUrl}  ${info}\n`)
    }
  }
  return results.every((r) => r.reachable) ? 0 : 1
}
