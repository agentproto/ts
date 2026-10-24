/**
 * llm-gateway — the daemon-managed `@agentproto/llm-endpoint` PROXY sidecar
 * itself (`features.llmEndpoint` / `LlmEndpointRegistry`). NOT the same
 * thing as `local-models.ts`, which probes the named local/LAN model
 * ENDPOINTS the gateway routes to — this step is about whether the gateway
 * process is up at all.
 *
 * Reports ok/managed (daemon spawned it, healthy) / ok/external (adopted —
 * a healthy process on the port the daemon did NOT spawn, e.g. a hand-made
 * launchd job) / skipped (feature off — not required, same stance as
 * local-models.ts) / warn (feature on but not actually running) / broken
 * (an unexpected error talking to a live daemon), plus port, version, and
 * served providers when known. Read-only: reaches the daemon's
 * `GET /llm-endpoint/status` REST route (this is a separate CLI invocation
 * from the live daemon process, so it can't read the in-process registry
 * directly) and never starts/stops/restarts anything itself.
 */

import { fetchHealth } from "../../commands/daemon.js"
import type { OnboardingStep, StepCheck, StepContext } from "../types.js"
import { errorMessage } from "./_util.js"

const CHECK_ID = "llm-gateway.status"
const TITLE = "LLM gateway (llm-endpoint proxy)"

/** Mirrors `LlmEndpointStatusReport` (`@agentproto/runtime`) — re-declared
 *  rather than imported so this onboarding step (like every other one)
 *  stays a thin fetch + shape-check over the daemon's own REST contract. */
interface LlmEndpointStatusReport {
  running: boolean
  pid: number | null
  port: number | null
  baseUrl: string | null
  healthy: boolean
  startedAt: string | null
  status: string
  owner: "daemon" | "external"
  linksApplied: boolean
  lastError?: string
  injectedProviders?: string[]
  linkedProviders?: string[]
  version?: string
}

type StatusFetchResult =
  | { ok: true; status: LlmEndpointStatusReport }
  | { ok: false; code: "not_registered" }
  | { ok: false; code: "error"; detail: string }

/** Narrow an arbitrary parsed JSON body to the `LlmEndpointStatusReport`
 *  shape — an unexpected shape (an older/newer daemon build, or a 200
 *  answered by something else entirely on that port/path) is treated the
 *  same as "route not registered" (`not_registered`) rather than surfaced as
 *  `broken`: `detect()` already confirmed the daemon itself is healthy via
 *  `/health` above, so this is a defensive fallback, not a masked error. */
function isLlmEndpointStatusReport(body: unknown): body is LlmEndpointStatusReport {
  return (
    typeof body === "object" &&
    body !== null &&
    ((body as Record<string, unknown>).owner === "daemon" ||
      (body as Record<string, unknown>).owner === "external")
  )
}

async function fetchLlmEndpointStatus(
  ctx: StepContext,
  baseUrl: string,
): Promise<StatusFetchResult> {
  try {
    const res = await ctx.fetch(`${baseUrl}/llm-endpoint/status`, {
      signal: AbortSignal.timeout(2000),
    })
    if (res.status === 404) return { ok: false, code: "not_registered" }
    if (!res.ok) return { ok: false, code: "error", detail: `HTTP ${res.status}` }
    const body: unknown = await res.json()
    if (!isLlmEndpointStatusReport(body)) return { ok: false, code: "not_registered" }
    return { ok: true, status: body }
  } catch (err) {
    return { ok: false, code: "error", detail: errorMessage(err) }
  }
}

export const llmGatewayStep: OnboardingStep = {
  id: "llm-gateway",
  title: "LLM gateway",
  required: false,
  async detect(ctx): Promise<StepCheck[]> {
    const config = await ctx.sources.loadConfig()
    const info = await fetchHealth({ config, fetchImpl: ctx.fetch })
    if (!info) {
      return [
        {
          id: CHECK_ID,
          title: TITLE,
          status: "skipped",
          detail: "daemon not reachable — see the Daemon step",
        },
      ]
    }

    const result = await fetchLlmEndpointStatus(ctx, info.url)

    if (!result.ok && result.code === "not_registered") {
      // Not required — most installs never touch llm-endpoint, which is a
      // perfectly fine, unconfigured state (mirrors local-models.ts's
      // "skipped" stance for the same reason), not a problem to fix.
      return [
        {
          id: CHECK_ID,
          title: TITLE,
          status: "skipped",
          detail: "features.llmEndpoint is off — no sidecar managed",
          fix:
            "set features.llmEndpoint: true in config.json (or configure a named " +
            "endpoint / upstream link / an llm-endpoint route to enable it by " +
            "default), then restart the daemon",
          data: { enabled: false },
        },
      ]
    }
    if (!result.ok) {
      return [
        {
          id: CHECK_ID,
          title: TITLE,
          status: "broken",
          detail: result.detail,
        },
      ]
    }

    const s = result.status
    const providers =
      s.injectedProviders && s.injectedProviders.length > 0
        ? ` — providers: ${s.injectedProviders.join(", ")}`
        : ""
    const versionSuffix = s.version ? ` v${s.version}` : ""
    const data = {
      owner: s.owner,
      port: s.port,
      healthy: s.healthy,
      version: s.version ?? null,
      status: s.status,
    }

    if (s.owner === "external") {
      return [
        {
          id: CHECK_ID,
          title: TITLE,
          status: "ok",
          detail: `external${versionSuffix} — healthy at ${s.baseUrl}${providers} ` +
            "(a process the daemon didn't spawn; it was adopted read-only)",
          data,
        },
      ]
    }
    if (s.running && s.healthy) {
      return [
        {
          id: CHECK_ID,
          title: TITLE,
          status: "ok",
          detail: `managed${versionSuffix} — healthy at ${s.baseUrl}${providers}`,
          data,
        },
      ]
    }
    return [
      {
        id: CHECK_ID,
        title: TITLE,
        status: "warn",
        detail: s.lastError
          ? `not running (${s.status}) — ${s.lastError}`
          : `not running (status: ${s.status})`,
        fix: "agentproto llm gateway restart",
        data,
      },
    ]
  },
}
