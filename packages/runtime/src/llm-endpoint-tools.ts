/**
 * MCP tools that expose the LlmEndpointRegistry to agents connected to the
 * daemon. Lets a remote operator start, stop, and inspect the
 * `@agentproto/llm-endpoint` proxy sidecar without running
 * `pnpm --filter @agentproto/llm-endpoint serve` by hand.
 *
 * Three tools:
 *   llm_endpoint_start   spawn (or reuse) the proxy child, inject provider keys
 *   llm_endpoint_stop    SIGTERM the proxy + mark stopped
 *   llm_endpoint_status  descriptor + live `GET /v1/models` health probe
 *
 * Designed parallel to tunnel-tools.ts — same error-shape, same style.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { listAuthProfiles } from "@agentproto/auth"
import type { LlmEndpointRegistry } from "./llm-endpoint-registry.js"
import {
  CANONICAL_UPSTREAMS,
  eligibleProfilesForUpstream,
  isCanonicalUpstream,
  listLlmEndpointLinks,
  removeLlmEndpointLink,
  setLlmEndpointLink,
} from "./llm-endpoint-links-store.js"
import { paginate, pageParamsShape, toolText } from "./tool-envelope.js"

export interface RegisterLlmEndpointToolsOptions {
  registry: LlmEndpointRegistry
}

function text(value: string | object): {
  content: Array<{ type: "text"; text: string }>
} {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value),
      },
    ],
  }
}

function errText(
  toolName: string,
  err: unknown,
): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return {
    content: [
      {
        type: "text",
        text: `${toolName}: ${err instanceof Error ? err.message : String(err)}`,
      },
    ],
    isError: true,
  }
}

export function registerLlmEndpointTools(
  server: McpServer,
  opts: RegisterLlmEndpointToolsOptions,
): void {
  const { registry } = opts

  // ── llm_endpoint_start ─────────────────────────────────────────
  server.tool(
    "llm_endpoint_start",
    "Start the @agentproto/llm-endpoint proxy gateway as a daemon-supervised " +
      "sidecar (spawns `node <bin> serve` as a child process). Injects the " +
      "stored provider API keys, `LLM_ENDPOINT_PORT` (default 18090), and " +
      "`LLM_ENDPOINT_ACCESS_TOKENS` (when supplied) into the child's env. " +
      "Idempotent: if the proxy is already running and healthy, returns the " +
      "existing descriptor without spawning a second process. Returns the " +
      "descriptor {pid, port, baseUrl, status, startedAt} once ready.",
    {
      port: z
        .number()
        .int()
        .min(1)
        .max(65535)
        .optional()
        .describe(
          "Port to bind. Defaults to the LLM_ENDPOINT_PORT env, then 18090.",
        ),
      accessTokens: z
        .string()
        .optional()
        .describe(
          "Value for LLM_ENDPOINT_ACCESS_TOKENS — the bearer token(s) the " +
            "proxy requires on inbound requests. Omit to leave the proxy open " +
            "(auth handled upstream / not gated).",
        ),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          "Extra environment variables for the spawn. Explicit env always " +
            "wins over injected provider keys and the port default.",
        ),
      binPath: z
        .string()
        .optional()
        .describe(
          "Override the llm-endpoint bin path. Defaults to auto-resolution / " +
            "the LLM_ENDPOINT_BIN env.",
        ),
    },
    async input => {
      try {
        const desc = await registry.start({
          ...(input.port != null ? { port: input.port } : {}),
          ...(input.accessTokens != null ? { accessTokens: input.accessTokens } : {}),
          ...(input.env ? { env: input.env } : {}),
          ...(input.binPath ? { binPath: input.binPath } : {}),
        })
        return text(desc)
      } catch (err) {
        return errText("llm_endpoint_start", err)
      }
    },
  )

  // ── llm_endpoint_stop ──────────────────────────────────────────
  server.tool(
    "llm_endpoint_stop",
    "Stop the llm-endpoint proxy — SIGTERM the child process and mark it " +
      "stopped. Idempotent on an already-stopped (or never-started) endpoint.",
    {},
    async () => {
      try {
        const ok = await registry.stop()
        return text({ ok })
      } catch (err) {
        return errText("llm_endpoint_stop", err)
      }
    },
  )

  // ── llm_endpoint_status ────────────────────────────────────────
  server.tool(
    "llm_endpoint_status",
    "Report the llm-endpoint proxy's current state: " +
      "{running, pid, port, baseUrl, healthy, startedAt}. `healthy` reflects a " +
      "live `GET /v1/models` probe against the running child.",
    {},
    async () => {
      try {
        const s = await registry.status()
        return text(s)
      } catch (err) {
        return errText("llm_endpoint_status", err)
      }
    },
  )

  // ── llm_endpoint_set_upstream_link ─────────────────────────────
  server.tool(
    "llm_endpoint_set_upstream_link",
    "Link (or unlink) a proxy upstream to a named auth-profile. A link is " +
      "persisted to `~/.agentproto/llm-endpoint-links.json`; the daemon injects " +
      "it as `LLM_ENDPOINT_PROFILE_<UPSTREAM>=<profileId>` when it spawns the " +
      "proxy, so the upstream authenticates from that profile instead of a bare " +
      "per-provider env key. Pass `profileId: null` to clear the link (revert to " +
      "the env-key path). The env is read only at proxy SPAWN, so a change to a " +
      "RUNNING proxy takes effect on the next restart — this verb persists the " +
      "link and reports `restartRequired`; it never restarts the proxy itself " +
      "(that would silently drop the running child's port / access tokens). " +
      "Does NOT validate that the profile exists — a dangling link resolves to a " +
      "401 at request time, as an absent credential does today.",
    {
      provider: z
        .string()
        .describe(
          `Upstream to link. One of: ${CANONICAL_UPSTREAMS.join(", ")}.`,
        ),
      profileId: z
        .string()
        .nullable()
        .describe("Auth-profile id to link, or null to clear the link (unlink)."),
    },
    async ({ provider, profileId }) => {
      try {
        if (!isCanonicalUpstream(provider)) {
          return errText(
            "llm_endpoint_set_upstream_link",
            new Error(
              `Unknown upstream "${provider}". Known: ${CANONICAL_UPSTREAMS.join(", ")}.`,
            ),
          )
        }
        let cleared = false
        if (profileId === null) {
          cleared = await removeLlmEndpointLink(provider)
        } else {
          await setLlmEndpointLink(provider, profileId)
        }
        // The env is read at spawn — a running proxy must be restarted to apply
        // this change. If it's stopped, the change applies on the next start.
        const s = await registry.status()
        const restartRequired = s.running
        return text({
          ok: true,
          provider,
          profileId,
          cleared: profileId === null ? cleared : undefined,
          // The persisted link is authoritative on the next spawn; it is never
          // hot-applied to the running child.
          applied: false,
          restartRequired,
        })
      } catch (err) {
        return errText("llm_endpoint_set_upstream_link", err)
      }
    },
  )

  // ── llm_endpoint_list_links ────────────────────────────────────
  server.tool(
    "llm_endpoint_list_links",
    "List the persisted upstream→auth-profile links plus, per upstream, the " +
      "auth-profiles ELIGIBLE to be linked. A profile is eligible for upstream " +
      "P iff its billing endpoint equals P, its method is compatible (api-key " +
      "for any upstream; oauth-bearer only for anthropic), and it is not " +
      "disabled. Reports the desired (persisted) link — a running proxy may lag " +
      "until restarted (see `llm_endpoint_set_upstream_link`). Never returns a " +
       "secret: eligible profiles carry only {id, label, method, endpoint}.",
    { ...pageParamsShape },
    async input => {
      try {
        const [links, profiles] = await Promise.all([
          listLlmEndpointLinks(),
          listAuthProfiles(),
        ])
        const upstreams = CANONICAL_UPSTREAMS.map(provider => ({
          provider,
          linkedProfile: links[provider] ?? null,
          eligible: eligibleProfilesForUpstream(profiles, provider).map(p => ({
            id: p.id,
            ...(p.label != null ? { label: p.label } : {}),
            method: p.method,
            endpoint: p.endpoint,
          })),
        }))
        // Pagination LAST — pages the per-upstream list. Without limit/
        // cursor the output is byte-identical to the pre-pagination handler.
        if (input.limit !== undefined || input.cursor !== undefined) {
          const page = paginate(upstreams, input, { maxLimit: 200, keyOf: u => u.provider })
          return { content: [{ type: "text", text: toolText(page, input) }] }
        }
        return text({ links, upstreams })
      } catch (err) {
        return errText("llm_endpoint_list_links", err)
      }
    },
  )
}
