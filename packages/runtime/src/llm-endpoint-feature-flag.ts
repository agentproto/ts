/**
 * Smart default for `features.llmEndpoint` (daemon-managed-gateway): an
 * operator who already configured a named endpoint, an upstream credential
 * link, or an explicit `llm-endpoint` custom route is clearly USING the
 * proxy already — booting with the sidecar off (today's default) would
 * silently break their next `route:{gateway:"llm-endpoint"}` spawn on a
 * fresh install. An operator who never touched any of that gets the
 * unchanged, conservative default (off).
 *
 * An explicit `configured` value (`config.json`'s `features.llmEndpoint`,
 * profile-overlaid) always wins, in either direction — this resolver only
 * fills in the gap when the operator left the flag unset.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { listLlmEndpointLinks } from "./llm-endpoint-links-store.js"
import { loadOperatorRoutes } from "./routes-config.js"

/**
 * Light duck-type read of `~/.agentproto/llm-endpoints.json`'s
 * `{ endpoints: [...] }` envelope — enough to detect "at least one entry
 * configured". Deliberately NOT the real validated parse
 * (`parseEndpointsConfig`, `@agentproto/llm-endpoint`): the runtime package
 * has zero dependency on that package (same stance as the proxy sidecar
 * itself, spawned as a child bin, never imported). A malformed file reads as
 * "no endpoints" here — the CLI's `agentproto llm endpoints list` / `doctor`
 * are where a malformed file is actually surfaced as an error.
 */
async function hasNamedLlmEndpoints(): Promise<boolean> {
  const override = process.env.LLM_ENDPOINT_ENDPOINTS_FILE?.trim()
  const path = override && override.length > 0 ? override : join(homedir(), ".agentproto", "llm-endpoints.json")
  try {
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as { endpoints?: unknown }
    return Array.isArray(parsed.endpoints) && parsed.endpoints.length > 0
  } catch {
    return false
  }
}

/**
 * Resolve the EFFECTIVE `features.llmEndpoint` flag. `configured` is the
 * operator's merged config value (`undefined` when never set in either
 * `config.json` or the active profile).
 */
export async function resolveEffectiveLlmEndpointFlag(
  configured: boolean | undefined,
): Promise<boolean> {
  if (configured !== undefined) return configured
  if (await hasNamedLlmEndpoints()) return true
  const links = await listLlmEndpointLinks().catch(() => ({}) as Record<string, string>)
  if (Object.keys(links).length > 0) return true
  const routes = await loadOperatorRoutes().catch(() => ({ routes: {}, errors: [] }))
  if (Object.prototype.hasOwnProperty.call(routes.routes, "llm-endpoint")) return true
  return false
}
