/**
 * local-models — each endpoint the LLM gateway would route to (the implicit
 * `forge` env-configured endpoint, plus every entry in
 * `~/.agentproto/llm-endpoints.json`) is reachable and answers `/models`.
 * Not required: most installs have no local/LAN model server at all, which is
 * a perfectly fine, unconfigured state — not a problem to fix.
 */

import { join } from "node:path"
import { parseEndpointsConfig, type EndpointConfig } from "@agentproto/llm-endpoint"
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

/** GET `<baseUrl>/models`, time-boxed — never throws, resolves a StepCheck
 *  either way (mirrors the gateway's own GET /v1/endpoints probe). */
async function probeEndpoint(ctx: StepContext, id: string, baseUrl: string): Promise<StepCheck> {
  const checkId = `local-models.${id}`
  const title = `Endpoint "${id}"`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await ctx.fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { signal: controller.signal })
    if (!res.ok) {
      return { id: checkId, title, status: "warn", detail: `${baseUrl} responded HTTP ${res.status}`, data: { baseUrl, reachable: false } }
    }
    return { id: checkId, title, status: "ok", detail: `${baseUrl} reachable`, data: { baseUrl, reachable: true } }
  } catch (err) {
    return { id: checkId, title, status: "warn", detail: `${baseUrl} unreachable: ${errorMessage(err)}`, data: { baseUrl, reachable: false } }
  } finally {
    clearTimeout(timeout)
  }
}

export const localModelsStep: OnboardingStep = {
  id: "local-models",
  title: "Local model endpoints",
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
    const targets = [
      ...(forgeBaseUrl ? [{ id: "forge", baseUrl: forgeBaseUrl }] : []),
      ...entries.map((e) => ({ id: e.id, baseUrl: e.baseUrl })),
    ]
    if (targets.length === 0) {
      return [
        {
          id: "local-models.configured",
          title: "Local model endpoints",
          status: "skipped",
          detail: `none configured (${tildify(ctx, path)})`,
          data: { path, count: 0 },
        },
      ]
    }
    return Promise.all(targets.map((t) => probeEndpoint(ctx, t.id, t.baseUrl)))
  },
}
