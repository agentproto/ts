/**
 * MCP tools that expose the TunnelRegistry to agents connected to the
 * daemon. Lets a remote operator create, list, stop, and inspect
 * public tunnels for any local port without touching the terminal.
 *
 * Four tools:
 *   create_tunnel    spawn a public URL for a local port (cloudflared quick tunnel)
 *   list_tunnels     browse active + historical tunnels
 *   stop_tunnel      SIGTERM the tunnel provider + mark stopped
 *   tunnel_status    read-only descriptor for one tunnel
 *
 * Designed parallel to session-tools.ts — same error-shape, same style.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { TunnelRegistry } from "./tunnel-registry.js"

export interface RegisterTunnelToolsOptions {
  registry: TunnelRegistry
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

export function registerTunnelTools(
  server: McpServer,
  opts: RegisterTunnelToolsOptions,
): void {
  const { registry } = opts

  // ── create_tunnel ──────────────────────────────────────────────
  server.tool(
    "create_tunnel",
    "Spawn a public HTTPS URL for a local port. Two backends: `quick` " +
      "(default) = Cloudflare Quick Tunnel, no API key, ephemeral " +
      "*.trycloudflare.com URL; `named` = a cloudflared tunnel you " +
      "provisioned once (`cloudflared tunnel create` + `route dns`), bound " +
      "to a STABLE hostname that survives restarts — pass `hostname` + " +
      "`tunnelId`, and set `autostart:true` to have the daemon relaunch it " +
      "on boot. Returns the TunnelDescriptor once cloudflared is ready " +
      "(typically <10s). Use `list_tunnels` before opening a duplicate. " +
      "Unlike `remote_enable`, this does NOT gate auth — pure passthrough; " +
      "the proxied service handles its own authn.",
    {
      targetPort: z
        .number()
        .int()
        .min(1)
        .max(65535)
        .describe("Local port to expose publicly (e.g. 3000 for a dev server)."),
      provider: z
        .enum(["quick", "named"])
        .optional()
        .describe(
          "Tunnel backend. `quick` = Cloudflare Quick Tunnel (default, " +
            "ephemeral URL). `named` = persistent hostname (requires " +
            "`hostname` + `tunnelId`).",
        ),
      name: z
        .string()
        .optional()
        .describe(
          "Optional friendly slug (e.g. 'vite-preview'). Accepted as an " +
            "alias for the tunnel id in `stop_tunnel` and `tunnel_status`.",
        ),
      label: z
        .string()
        .optional()
        .describe("Free-text label shown in `list_tunnels` output."),
      targetHost: z
        .string()
        .optional()
        .describe(
          "Host the tunnel forwards to. Defaults to `127.0.0.1`. Use " +
            "`localhost` only if the target is explicitly IPv6-bound.",
        ),
      autostart: z
        .boolean()
        .optional()
        .describe(
          "Relaunch this tunnel automatically on daemon boot. Only useful " +
            "for `named` tunnels (a relaunched quick tunnel gets a new URL).",
        ),
      hostname: z
        .string()
        .optional()
        .describe(
          "REQUIRED for `named`: the stable public hostname routed to the " +
            "tunnel (e.g. app.example.com).",
        ),
      tunnelId: z
        .string()
        .optional()
        .describe(
          "REQUIRED for `named`: the cloudflared tunnel id or name to run " +
            "(from `cloudflared tunnel create`).",
        ),
      credentialsFile: z
        .string()
        .optional()
        .describe(
          "Optional for `named`: path to the tunnel credentials JSON. " +
            "Defaults to ~/.cloudflared/<tunnelId>.json.",
        ),
    },
    async input => {
      try {
        const desc = await registry.create({
          targetPort: input.targetPort,
          ...(input.provider ? { provider: input.provider } : {}),
          ...(input.name ? { name: input.name } : {}),
          ...(input.label ? { label: input.label } : {}),
          ...(input.targetHost ? { targetHost: input.targetHost } : {}),
          ...(input.autostart ? { autostart: true } : {}),
          ...(input.hostname ? { hostname: input.hostname } : {}),
          ...(input.tunnelId ? { tunnelId: input.tunnelId } : {}),
          ...(input.credentialsFile ? { credentialsFile: input.credentialsFile } : {}),
        })
        return text(desc)
      } catch (err) {
        return errText("create_tunnel", err)
      }
    },
  )

  // ── list_tunnels ───────────────────────────────────────────────
  server.tool(
    "list_tunnels",
    "List all tunnels tracked by the daemon — active, stopped, and errored. " +
      "Each entry includes provider, target port, public URL, status, pid, " +
      "and age. Use before `create_tunnel` to avoid spawning duplicates " +
      "for the same port.",
    {
      onlyActive: z
        .boolean()
        .optional()
        .describe(
          "When true, return only tunnels with status `starting` or `active`. " +
            "Default false (return all).",
        ),
    },
    async input => {
      let tunnels = registry.list()
      if (input.onlyActive) {
        tunnels = tunnels.filter(
          t => t.status === "starting" || t.status === "active",
        )
      }
      return text({ tunnels })
    },
  )

  // ── stop_tunnel ────────────────────────────────────────────────
  server.tool(
    "stop_tunnel",
    "Stop an active tunnel — SIGTERM cloudflared and mark the tunnel stopped. " +
      "Accepts either the tunnel id or the friendly name set at create time. " +
      "Idempotent on an already-stopped tunnel.",
    {
      tunnelId: z
        .string()
        .min(1)
        .describe(
          "Tunnel id (UUID from `create_tunnel`) or the name slug " +
            "(e.g. 'vite-preview').",
        ),
    },
    async input => {
      try {
        const ok = await registry.stop(input.tunnelId)
        if (!ok) {
          return {
            content: [
              {
                type: "text",
                text: `stop_tunnel: no tunnel "${input.tunnelId}" — use list_tunnels to see current ids`,
              },
            ],
            isError: true,
          }
        }
        return text({ ok, tunnelId: input.tunnelId })
      } catch (err) {
        return errText("stop_tunnel", err)
      }
    },
  )

  // ── tunnel_status ──────────────────────────────────────────────
  server.tool(
    "tunnel_status",
    "Return the current descriptor for one tunnel. Accepts either the " +
      "tunnel id or the friendly name set at create time.",
    {
      tunnelId: z
        .string()
        .min(1)
        .describe(
          "Tunnel id (UUID from `create_tunnel`) or the name slug.",
        ),
    },
    async input => {
      const desc = registry.findByIdOrName(input.tunnelId)
      if (!desc) {
        return {
          content: [
            {
              type: "text",
              text: `tunnel_status: no tunnel "${input.tunnelId}" — use list_tunnels to see current ids`,
            },
          ],
          isError: true,
        }
      }
      return text(desc)
    },
  )
}
