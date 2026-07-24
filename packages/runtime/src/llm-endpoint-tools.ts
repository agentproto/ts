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
import type { LlmEndpointRegistry } from "./llm-endpoint-registry.js"

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
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
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
}
