/**
 * MCP tools that drive RemoteController — the gateway's "publish to
 * the internet" surface.
 *
 * Three tools, mirroring the controller's lifecycle:
 *
 *   remote_enable   — bring up a tunnel, mint bearer token, return the
 *                     public /mcp URL + a paste-ready .mcp.json snippet
 *   remote_disable  — tear down tunnel, revoke token, drop bearer auth
 *   remote_status   — read-only — provider, URL, pid, lastError
 *
 * Why this lives on the MCP surface (not a separate CLI):
 *   - The user already has an MCP client connected (that's how they
 *     started talking to the gateway in the first place). One tool call
 *     replaces an entire CLI install + auth dance.
 *   - The bearer token comes back as part of the MCP response, so it
 *     doesn't have to land on the user's clipboard.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import type { RemoteController } from "./remote-controller.js"

export interface RegisterRemoteToolsOptions {
  controller: RemoteController
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

export function registerRemoteTools(
  server: McpServer,
  opts: RegisterRemoteToolsOptions,
): void {
  const { controller } = opts

  server.tool(
    "remote_enable",
    "Publish a local port to the internet via Cloudflare. By default exposes " +
      "this gateway and gates it with a bearer token (returned ONCE in the " +
      "response — store it; only its hash is persisted). Pass `targetPort` to " +
      "tunnel a different local service (Supabase, dev server, …); in that mode " +
      "the daemon does not gate the proxied traffic — the upstream service " +
      "handles its own auth. Returns the public URL plus a paste-ready " +
      "`.mcp.json` snippet (gateway mode only). Re-running while a tunnel is " +
      "already up errors; call `remote_disable` first to rotate.",
    {
      provider: z
        .enum(["quick"])
        .optional()
        .describe(
          "Tunnel backend. `quick` = Cloudflare Quick Tunnel (no API key, ephemeral *.trycloudflare.com URL). Defaults to `quick`. Named-CF / Tailscale providers TBD.",
        ),
      targetPort: z
        .number()
        .int()
        .min(1)
        .max(65535)
        .optional()
        .describe(
          "Local port to expose. Defaults to this gateway's own port (= publish the MCP server). Pass another port to tunnel a different local service (e.g. 54371 for Supabase) — in that mode bearer auth is OFF since the upstream handles its own gating.",
        ),
      targetHost: z
        .string()
        .optional()
        .describe(
          "Host the tunnel forwards to. Defaults to `127.0.0.1`. Use `localhost` only if the target is explicitly IPv6-bound; cloudflared resolves DNS and IPv6-first lookups can break IPv4-only origins.",
        ),
    },
    async ({ provider, targetPort, targetHost }) => {
      const result = await controller.enable({ provider, targetPort, targetHost })
      return text(result)
    },
  )

  server.tool(
    "remote_disable",
    "Tear down the active remote tunnel and drop bearer auth back to " +
      "loopback-only. Idempotent — calling when no tunnel is active is a no-op.",
    {},
    async () => {
      const result = await controller.disable()
      return text(result)
    },
  )

  server.tool(
    "remote_status",
    "Report whether a remote tunnel is active. When active: provider, " +
      "public URL, supervised PID, createdAt. The bearer token itself is " +
      "never returned by status — it was shown once at enable.",
    {},
    async () => {
      return text(controller.status())
    },
  )
}
