/**
 * local-models — each endpoint the LLM gateway would route to (the implicit
 * `forge` env-configured endpoint, plus every entry in
 * `~/.agentproto/llm-endpoints.json`) is reachable and answers `/models`. A
 * reachable, file-configured endpoint (forge excluded — it has no connector
 * concept) also reports what its connector (`entry.connector`, default
 * `openai-compatible`) sees via `listModels`. Not required: most installs
 * have no local/LAN model server at all, which is a perfectly fine,
 * unconfigured state — not a problem to fix.
 *
 * Also probes the default local ports for a runtime running but NOT YET a
 * configured endpoint (`detectUnconfiguredRuntimes`) — this is what makes
 * `setup` offer to run `agentproto llm endpoints detect` even on a fresh
 * machine that has never configured anything (a step whose only check is
 * "nothing configured" is otherwise already settled, and `plan()` is never
 * called for a settled step — see `wizard.ts`).
 */

import { join } from "node:path"
import {
  connectorById,
  parseEndpointsConfig,
  DEFAULT_LOCAL_PORTS,
  checkHarnessFit,
  HARNESS_FIRST_REQUEST_SIZE,
  type ConnectorId,
  type ConnectorModel,
  type EndpointConfig,
} from "@agentproto/llm-endpoint"
import type { OnboardingStep, StepCheck, StepContext } from "../types.js"
import { errorMessage, readText, tildify } from "./_util.js"

const PROBE_TIMEOUT_MS = 4000

/**
 * Mirrors `resolveEndpointsFilePath` (`@agentproto/llm-endpoint`) but reads
 * `ctx.env`/`ctx.homedir` instead of `process.env`/`os.homedir()` directly,
 * so this step stays fakeable in tests like every other onboarding step.
 */
function resolveLocalEndpointsPath(ctx: StepContext): string {
  const override = ctx.env.LLM_ENDPOINT_ENDPOINTS_FILE?.trim()
  if (override) return override
  return join(ctx.homedir, ".agentproto", "llm-endpoints.json")
}

interface LoadedEndpoints {
  entries: EndpointConfig[]
  error: string | null
  path: string
}

/** A missing file means "no named endpoints configured" (not an error) —
 *  same fail-soft rule as the gateway's own load path. Malformed JSON or a
 *  shape error IS an error, surfaced as a single "broken" check below. */
async function loadEndpoints(ctx: StepContext): Promise<LoadedEndpoints> {
  const path = resolveLocalEndpointsPath(ctx)
  const text = await readText(ctx, path)
  if (text === null) return { entries: [], error: null, path }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { entries: [], error: `invalid JSON — ${errorMessage(err)}`, path }
  }
  const result = parseEndpointsConfig(parsed)
  if (result.errors.length > 0) return { entries: [], error: result.errors.join("; "), path }
  return { entries: result.endpoints, error: null, path }
}

const KNOWN_HARNESSES = Object.keys(HARNESS_FIRST_REQUEST_SIZE)

/** Which known harnesses (`agent_start.inference`'s fit check) fit a loaded
 *  model's ctx, e.g. `"pi✓ claude-code✗"`. `undefined` loaded ctx (a
 *  connector like Ollama that never reports one) still names every harness
 *  as `?` (unknown) — informational, not a failure. */
function fitSummary(loadedCtx: number | undefined): string {
  return KNOWN_HARNESSES.map((harness) => {
    const verdict = checkHarnessFit({ harness, loadedCtx }).verdict
    return `${harness}${verdict === "fits" ? "✓" : verdict === "no-fit" ? "✗" : "?"}`
  }).join(" ")
}

/** One line summarizing a connector's model listing, or `null` when there's
 *  nothing to add (no models reported). Loaded vs. not-loaded is
 *  informational — never downgrades the check's status. */
function summarizeModels(models: ConnectorModel[]): string | null {
  if (models.length === 0) return null
  const loaded = models.filter((m) => m.state === "loaded")
  if (loaded.length === 0) return `${models.length} model${models.length === 1 ? "" : "s"}, none loaded`
  const describe = (m: ConnectorModel): string => {
    const ctxPart = m.loadedCtx !== undefined && m.maxCtx !== undefined ? `, ctx ${m.loadedCtx}/${m.maxCtx}` : ""
    return `${m.id}${ctxPart} [${fitSummary(m.loadedCtx)}]`
  }
  return `${loaded.length} loaded (${loaded.map(describe).join("; ")})`
}

/** GET `<baseUrl>/models`, time-boxed — never throws, resolves a StepCheck
 *  either way (mirrors the gateway's own GET /v1/endpoints probe). When
 *  `connectorId` is given (every target except `forge`, which has no
 *  connector concept), a reachable endpoint is also asked what models its
 *  connector sees. */
async function probeEndpoint(ctx: StepContext, id: string, baseUrl: string, connectorId?: ConnectorId): Promise<StepCheck> {
  const checkId = `local-models.${id}`
  const title = `Endpoint "${id}"`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await ctx.fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { signal: controller.signal })
    if (!res.ok) {
      return { id: checkId, title, status: "warn", detail: `${baseUrl} responded HTTP ${res.status}`, data: { baseUrl, reachable: false } }
    }
    if (connectorId === undefined) {
      return { id: checkId, title, status: "ok", detail: `${baseUrl} reachable`, data: { baseUrl, reachable: true } }
    }
    const connector = connectorById(connectorId)
    const models = connector ? await connector.listModels(baseUrl, ctx.fetch) : []
    const summary = summarizeModels(models)
    return {
      id: checkId,
      title,
      status: "ok",
      detail: `${baseUrl} reachable${summary ? ` — ${summary}` : ""}`,
      data: { baseUrl, reachable: true, connector: connectorId, models },
    }
  } catch (err) {
    return { id: checkId, title, status: "warn", detail: `${baseUrl} unreachable: ${errorMessage(err)}`, data: { baseUrl, reachable: false } }
  } finally {
    clearTimeout(timeout)
  }
}

/** Ports already covered by a configured endpoint that itself points at
 *  127.0.0.1/localhost — compared by host:port, not by id/connector, since a
 *  user is free to name an endpoint anything (`bonsai`, connector
 *  `lmstudio`) and it still means "this local port is already handled". */
function configuredLocalPorts(entries: readonly EndpointConfig[]): ReadonlySet<number> {
  const ports = new Set<number>()
  for (const e of entries) {
    try {
      const u = new URL(e.baseUrl)
      if (u.hostname === "127.0.0.1" || u.hostname === "localhost") {
        ports.add(u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80)
      }
    } catch {
      // already validated by parseEndpointsConfig — shouldn't happen.
    }
  }
  return ports
}

/**
 * Probe the default local ports for a runtime NOT already covered by a
 * configured endpoint — this is what lets `setup` offer to run `detect`
 * even on a machine that has never configured anything yet: a step whose
 * only check is "nothing configured" (status `skipped`) is otherwise
 * already "settled" and the wizard never calls `plan()` for it (see
 * `wizard.ts`'s `settled`/`checks.every` gate). Returns one `warn` check per
 * undetected runtime found running, `[]` if none — cheap (a handful of
 * short-timeout local probes), safe to run every `doctor`/`setup` pass.
 */
async function detectUnconfiguredRuntimes(ctx: StepContext, entries: readonly EndpointConfig[]): Promise<StepCheck[]> {
  const takenPorts = configuredLocalPorts(entries)
  const candidates = (Object.entries(DEFAULT_LOCAL_PORTS) as [ConnectorId, number][]).filter(([, port]) => !takenPorts.has(port))
  const found = await Promise.all(
    candidates.map(async ([id, port]) => {
      const connector = connectorById(id)
      if (!connector) return null
      const baseUrl = `http://127.0.0.1:${port}/v1`
      return (await connector.probe(baseUrl, ctx.fetch)) ? { id, baseUrl, label: connector.label } : null
    }),
  )
  return found
    .filter((f): f is { id: ConnectorId; baseUrl: string; label: string } => f !== null)
    .map((f) => ({
      id: `local-models.undetected.${f.id}`,
      title: `Undetected local model server (${f.label})`,
      status: "warn",
      detail: `${f.label} is running at ${f.baseUrl} but not yet a configured endpoint`,
      fix: "agentproto llm endpoints detect",
      data: { connector: f.id, baseUrl: f.baseUrl },
    }))
}

export const localModelsStep: OnboardingStep = {
  id: "local-models",
  title: "Inference endpoints",
  required: false,
  async detect(ctx) {
    const { entries, error, path } = await loadEndpoints(ctx)
    if (error) {
      return [
        {
          id: "local-models.config",
          title: "Endpoints file",
          status: "broken",
          detail: `${tildify(ctx, path)}: ${error}`,
          fix: "agentproto llm endpoints list",
          data: { path },
        },
      ]
    }

    const forgeBaseUrl = ctx.env.FORGE_BASE_URL?.trim()
    const targets: { id: string; baseUrl: string; connector?: ConnectorId }[] = [
      ...(forgeBaseUrl ? [{ id: "forge", baseUrl: forgeBaseUrl }] : []),
      ...entries.map((e) => ({ id: e.id, baseUrl: e.baseUrl, connector: e.connector ?? ("openai-compatible" as ConnectorId) })),
    ]
    const undetected = await detectUnconfiguredRuntimes(ctx, entries)

    if (targets.length === 0) {
      if (undetected.length > 0) return undetected
      return [
        {
          id: "local-models.configured",
          title: "Inference endpoints",
          status: "skipped",
          detail: `none configured (${tildify(ctx, path)})`,
          data: { path, count: 0 },
        },
      ]
    }
    const probed = await Promise.all(targets.map((t) => probeEndpoint(ctx, t.id, t.baseUrl, t.connector)))
    return [...probed, ...undetected]
  },
  async plan(checks) {
    // Only offer when there's actually something `detect` would fix — an
    // undetected runtime found running (see detectUnconfiguredRuntimes).
    // An unreachable already-configured endpoint also makes this step
    // unsettled, but `detect` can't repair that, so nothing is proposed.
    if (!checks.some((c) => c.id.startsWith("local-models.undetected."))) return []
    return [
      {
        id: "local-models.detect",
        title: "Detect local inference endpoints (LM Studio, Ollama, vLLM, llama-server) on their default ports",
        default: true,
        async apply(io) {
          const code = await io.verbs.llmEndpoints(["endpoints", "detect"])
          if (code !== 0) return { ok: false, detail: `llm endpoints detect exited ${code}` }
          // Bundled, not a separate action: this is the one moment a newly
          // detected endpoint is worth wiring into pi too. Non-fatal on its
          // own — most installs don't use pi, and detect's own success is
          // the part that matters.
          const syncCode = await io.verbs.llmEndpoints(["endpoints", "sync-pi"])
          return { ok: true, detail: syncCode === 0 ? "detected and synced ~/.pi/agent/models.json" : `detected (pi sync exited ${syncCode}, non-fatal)` }
        },
      },
    ]
  },
}
