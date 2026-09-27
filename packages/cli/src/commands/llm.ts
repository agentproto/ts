/**
 * `agentproto llm endpoints <list|test|add|remove|detect>`
 *
 * Read/write visibility into the LLM gateway's named OpenAI-compatible
 * endpoints (local/LAN model servers — LM Studio, Ollama, llama-server,
 * vLLM, …), configured in `~/.agentproto/llm-endpoints.json`
 * (`LLM_ENDPOINT_ENDPOINTS_FILE` overrides the path) — the same file
 * `@agentproto/llm-endpoint` reads at request time to route `<id>/<model>`.
 *
 * `list`/`test` are read-only. `add`/`remove` edit the file for you (see the
 * package README's "Named endpoints" section for its shape) instead of
 * requiring a hand edit, and `detect` probes the well-known local ports for
 * a running runtime and writes/updates the matching entry. This mirrors how
 * `auth cred`/`auth profile` keep their own JSON stores.
 */

import { parseArgs } from "node:util"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import {
  readEndpointsFromDisk,
  resolveEndpointsFilePath,
  parseEndpointsConfig,
  connectorById,
  detectConnector,
  isConnectorId,
  CONNECTOR_IDS,
  DEFAULT_LOCAL_PORTS,
  type EndpointConfig,
  type ConnectorId,
  type ConnectorModel,
} from "@agentproto/llm-endpoint"
import { syncPiModels } from "../lib/pi-models.js"

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
  agentproto llm endpoints add <name> --url <baseUrl> [--connector <id>] [--api-key-env VAR] [--json]
  agentproto llm endpoints remove <name> [--json]
  agentproto llm endpoints detect [--dry-run] [--json]
  agentproto llm endpoints sync-pi [--dry-run] [--json]

Endpoints live in ~/.agentproto/llm-endpoints.json (LLM_ENDPOINT_ENDPOINTS_FILE
overrides the path) — see the @agentproto/llm-endpoint README's "Named
endpoints" section for the file's shape.
`

const ENDPOINTS_USAGE = `agentproto llm endpoints — named OpenAI-compatible endpoints

Usage:
  agentproto llm endpoints list [--json]
                          configured endpoints (id, baseUrl, whether its key
                          env var is set) — no network call.
  agentproto llm endpoints test [--json]
                          live reachability + model listing per endpoint (a
                          real GET <baseUrl>/models per entry, 4s timeout,
                          plus each endpoint's own connector.listModels() for
                          a reachable endpoint). Exit code is 1 if any
                          endpoint is unreachable.
  agentproto llm endpoints add <name> --url <baseUrl>
                          [--connector auto|${CONNECTOR_IDS.join("|")}]
                          [--api-key-env VAR] [--json]
                          Add a named endpoint and write it to the file.
                          --connector defaults to "auto": probes <baseUrl> to
                          identify the runtime, falling back to
                          "openai-compatible" (with a warning) if nothing
                          answers there yet — an explicit --connector skips
                          probing entirely.
  agentproto llm endpoints remove <name> [--json]
                          Remove a named endpoint from the file.
  agentproto llm endpoints detect [--dry-run] [--json]
                          Probe the default local ports (lmstudio 1234,
                          ollama 11434, llama-server 8080, vllm 8000) on
                          127.0.0.1 and add/update the matching endpoint for
                          each one found running. No local server running is
                          a normal outcome (exit 0). An existing entry whose
                          id matches a detected runtime but whose baseUrl
                          points somewhere other than 127.0.0.1/localhost
                          (e.g. a LAN address) is left untouched and reported
                          as skipped, never silently re-pointed at localhost.
                          --dry-run reports what would change without
                          writing the file.
  agentproto llm endpoints sync-pi [--dry-run] [--json]
                          Regenerate the matching provider entry in
                          ~/.pi/agent/models.json for every configured
                          endpoint, from its connector's LIVE loaded models
                          (contextWindow = loaded ctx, never max). Ollama's
                          API never reports a loaded model's context size, so
                          its models sync with a conservative 4096-token
                          fallback rather than being skipped — check the
                          runtime directly (e.g. "ollama show <model>") if you
                          need the real figure. Only ever touches model ids
                          this command previously wrote there (tracked in
                          ~/.agentproto/pi-models-managed.json) — a
                          hand-added provider or model is left untouched.
                          --dry-run reports what would change without
                          writing either file.
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
    case "add":
      return runEndpointsAdd(rest)
    case "remove":
    case "rm":
      return runEndpointsRemove(rest)
    case "detect":
      return runEndpointsDetect(rest)
    case "sync-pi":
      return runEndpointsSyncPi(rest)
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

/** Write `{ endpoints: [...] }` back to `path`, creating its parent dir
 *  (e.g. a fresh install's missing `~/.agentproto`) if needed. Shared by
 *  `add`/`remove`/`detect` — the only write path in this file; endpoints.ts
 *  itself is deliberately write-free. */
async function writeEndpointsFile(path: string, endpoints: EndpointConfig[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ endpoints }, null, 2)}\n`)
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
  connector: ConnectorId
  reachable: boolean
  models: string[]
  connectorModels?: ConnectorModel[]
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
 *  with a human-readable `detail`, mirroring the gateway's own GET /v1/endpoints.
 *  For a reachable endpoint, also runs its connector's own listModels() —
 *  richer, runtime-specific detail (load state, context size) on top of the
 *  generic OpenAI /models probe above. */
async function testOneEndpoint(endpoint: EndpointConfig): Promise<EndpointTestResult> {
  const connectorId: ConnectorId = endpoint.connector ?? "openai-compatible"
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
      return {
        id: endpoint.id,
        baseUrl: endpoint.baseUrl,
        connector: connectorId,
        reachable: false,
        models: [],
        latencyMs,
        detail: `HTTP ${res.status}`,
      }
    }
    const body: unknown = await res.json().catch(() => null)
    const connectorModels = await connectorById(connectorId)?.listModels(endpoint.baseUrl)
    return {
      id: endpoint.id,
      baseUrl: endpoint.baseUrl,
      connector: connectorId,
      reachable: true,
      models: extractModelIds(body),
      connectorModels: connectorModels ?? [],
      latencyMs,
    }
  } catch (err) {
    return {
      id: endpoint.id,
      baseUrl: endpoint.baseUrl,
      connector: connectorId,
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
      process.stdout.write(`  ${status}  ${r.id}  ${r.baseUrl}  connector=${r.connector}  ${info}\n`)
      if (r.reachable && r.connectorModels && r.connectorModels.length > 0) {
        for (const m of r.connectorModels) {
          const ctx =
            m.loadedCtx !== undefined && m.maxCtx !== undefined ? ` ctx=${m.loadedCtx}/${m.maxCtx}` : ""
          process.stdout.write(`      - ${m.id}  state=${m.state}${ctx}\n`)
        }
      }
    }
  }
  return results.every((r) => r.reachable) ? 0 : 1
}

async function runEndpointsAdd(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      url: { type: "string" },
      connector: { type: "string" },
      "api-key-env": { type: "string" },
      json: { type: "boolean" },
    },
  })
  const name = positionals[0]
  if (!name) {
    process.stderr.write(`agentproto llm endpoints add: missing <name>.\n\n${ENDPOINTS_USAGE}`)
    return 2
  }
  if (!values.url) {
    process.stderr.write(`agentproto llm endpoints add: missing --url <baseUrl>.\n\n${ENDPOINTS_USAGE}`)
    return 2
  }
  const connectorArg = values.connector ?? "auto"
  if (connectorArg !== "auto" && !isConnectorId(connectorArg)) {
    process.stderr.write(
      `agentproto llm endpoints add: --connector must be "auto" or one of ${CONNECTOR_IDS.join(", ")} (got "${connectorArg}").\n`,
    )
    return 2
  }

  const path = resolveEndpointsFilePath()
  const existing = loadConfiguredOrFail(path)
  if (existing === null) return 1

  let connector: ConnectorId
  if (connectorArg === "auto") {
    let urlLooksValid = true
    try {
      const parsed = new URL(values.url)
      urlLooksValid = parsed.protocol === "http:" || parsed.protocol === "https:"
    } catch {
      urlLooksValid = false
    }
    const detected = urlLooksValid ? await detectConnector(values.url) : null
    if (detected) {
      connector = detected
    } else {
      process.stderr.write(
        `agentproto llm endpoints add: nothing OpenAI-compatible answered at ${values.url}; ` +
          `storing connector: "openai-compatible" as a fallback (re-run \`agentproto llm ` +
          `endpoints detect\` once it's up if it turns out to be a known local runtime).\n`,
      )
      connector = "openai-compatible"
    }
  } else {
    connector = connectorArg
  }

  const candidate: EndpointConfig = { id: name, kind: "openai", baseUrl: values.url, connector }
  if (values["api-key-env"]) candidate.apiKeyEnv = values["api-key-env"]

  const { endpoints: rebuilt, errors } = parseEndpointsConfig({ endpoints: [...existing, candidate] })
  if (errors.length > 0) {
    process.stderr.write(
      `agentproto llm endpoints add: invalid endpoint:\n` + errors.map((e) => `  - ${e}\n`).join(""),
    )
    return 1
  }

  await writeEndpointsFile(path, rebuilt)

  const added = rebuilt.find((e) => e.id === name)!
  if (values.json) {
    process.stdout.write(JSON.stringify(added, null, 2) + "\n")
    return 0
  }
  process.stdout.write(`Added endpoint "${name}" (connector: ${connector}) -> ${added.baseUrl}\n`)
  return 0
}

async function runEndpointsRemove(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { json: { type: "boolean" } },
  })
  const name = positionals[0]
  if (!name) {
    process.stderr.write(`agentproto llm endpoints remove: missing <name>.\n\n${ENDPOINTS_USAGE}`)
    return 2
  }

  const path = resolveEndpointsFilePath()
  const existing = loadConfiguredOrFail(path)
  if (existing === null) return 1

  if (!existing.some((e) => e.id === name)) {
    process.stderr.write(
      `agentproto llm endpoints remove: no endpoint named "${name}" ` +
        `(known: ${existing.map((e) => e.id).join(", ") || "(none configured)"}).\n`,
    )
    return 1
  }

  const remaining = existing.filter((e) => e.id !== name)
  await writeEndpointsFile(path, remaining)

  if (values.json) {
    process.stdout.write(JSON.stringify({ removed: name, path }, null, 2) + "\n")
    return 0
  }
  process.stdout.write(`Removed endpoint "${name}" from ${path}.\n`)
  return 0
}

interface DetectedRuntime {
  id: ConnectorId
  baseUrl: string
  connector: ConnectorId
  action: "added" | "updated" | "would-add" | "would-update" | "skipped-elsewhere"
}

/** `true` only for `http://127.0.0.1[:port]/...` or `http://localhost[:port]/...`
 *  — anything else (a LAN IP, a hostname, https, …) is "points elsewhere" for
 *  the purposes of `detect`'s clobber guard below. Never throws. */
function isLocalhostUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url)
    return hostname === "127.0.0.1" || hostname === "localhost"
  } catch {
    return false
  }
}

async function runEndpointsDetect(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: {
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
    },
  })
  const dryRun = Boolean(values["dry-run"])

  const path = resolveEndpointsFilePath()
  const existing = loadConfiguredOrFail(path)
  if (existing === null) return 1
  const existingIds = new Set(existing.map((e) => e.id))

  const probed = await Promise.all(
    (Object.entries(DEFAULT_LOCAL_PORTS) as [ConnectorId, number][]).map(async ([id, port]) => {
      const connector = connectorById(id)
      if (!connector) return null
      const baseUrl = `http://127.0.0.1:${port}/v1`
      const alive = await connector.probe(baseUrl)
      return alive ? { id, baseUrl } : null
    }),
  )

  const detected: DetectedRuntime[] = []
  for (const hit of probed) {
    if (!hit) continue
    const { id, baseUrl } = hit
    const existingEntry = existing.find((e) => e.id === id)
    if (existingEntry && !isLocalhostUrl(existingEntry.baseUrl)) {
      // Never re-point a hand-configured LAN/remote endpoint at localhost —
      // report it and leave it exactly as the user wrote it.
      detected.push({ id, baseUrl, connector: id, action: "skipped-elsewhere" })
      continue
    }
    const already = existingIds.has(id)
    const action = already ? (dryRun ? "would-update" : "updated") : (dryRun ? "would-add" : "added")
    detected.push({ id, baseUrl, connector: id, action })
  }

  const actionable = detected.filter((d) => d.action === "added" || d.action === "updated")
  if (!dryRun && actionable.length > 0) {
    const rebuilt = existing.map((e) => {
      const d = actionable.find((x) => x.id === e.id)
      return d ? { ...e, baseUrl: d.baseUrl, connector: d.connector } : e
    })
    for (const d of actionable) {
      if (!existingIds.has(d.id)) rebuilt.push({ id: d.id, kind: "openai", baseUrl: d.baseUrl, connector: d.connector })
    }
    const { endpoints: parsed, errors } = parseEndpointsConfig({ endpoints: rebuilt })
    if (errors.length > 0) {
      process.stderr.write(
        `agentproto llm endpoints detect: invalid endpoint after rebuild:\n` +
          errors.map((e) => `  - ${e}\n`).join(""),
      )
      return 1
    }
    await writeEndpointsFile(path, parsed)
  }

  if (values.json) {
    process.stdout.write(JSON.stringify({ detected, path }, null, 2) + "\n")
    return 0
  }

  if (detected.length === 0) {
    process.stdout.write(
      "agentproto llm endpoints detect: no local model server detected on the default ports.\n",
    )
    return 0
  }
  for (const d of detected) {
    if (d.action === "skipped-elsewhere") {
      process.stdout.write(
        `Detected ${d.id} at ${d.baseUrl} -> existing endpoint "${d.id}" points elsewhere; ` +
          `left untouched (skipped)\n`,
      )
      continue
    }
    const verb = dryRun
      ? d.action === "would-add"
        ? "would write"
        : "would update"
      : d.action === "added"
        ? "wrote"
        : "updated"
    process.stdout.write(`Detected ${d.id} at ${d.baseUrl} -> ${verb} endpoint "${d.id}"\n`)
  }
  return 0
}

async function runEndpointsSyncPi(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: {
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
    },
  })
  const dryRun = Boolean(values["dry-run"])
  const result = await syncPiModels({ dryRun })

  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    return 0
  }

  if (result.entries.length === 0) {
    process.stdout.write("agentproto llm endpoints sync-pi: no endpoints configured, nothing to sync.\n")
    return 0
  }
  for (const e of result.entries) {
    if (e.action === "skipped-no-loaded-models") {
      process.stdout.write(`  ${e.providerId}  ${e.baseUrl}  no loaded models — skipped\n`)
      continue
    }
    const verb = dryRun
      ? e.action === "added"
        ? "would add"
        : e.action === "updated"
          ? "would update"
          : "unchanged"
      : e.action
    process.stdout.write(`  ${e.providerId}  ${e.baseUrl}  ${verb}  models: ${e.modelIds.join(", ") || "(none)"}\n`)
  }
  process.stdout.write(`${dryRun ? "Would write" : "Wrote"} ${result.modelsPath}\n`)
  return 0
}
