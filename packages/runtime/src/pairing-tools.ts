/**
 * MCP tools that drive the pairing registry — the daemon's "let a client pair
 * with me over an untrusted rendezvous" surface (design: DESIGN §6).
 *
 * Three tools, mirroring the CLI verbs:
 *
 *   pair_offer   — mint a one-time offer + start dialing the rendezvous; returns
 *                  the `agentproto://pair?…` URL, fingerprint, and expiry.
 *   pair_list    — list persisted pairings (name, fingerprint, lastSeen).
 *   pair_revoke  — drop a pairing by fingerprint or name; stops its rendezvous
 *                  connections so it can no longer reconnect.
 *
 * Registered beside `remote_*` (remote-tools.ts) — same closure-rebind pattern;
 * the registry singleton lives on the gateway.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { PairingRegistry } from "./pairing-registry.js"

export interface RegisterPairingToolsOptions {
  registry: PairingRegistry
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

export function registerPairingTools(
  server: McpServer,
  opts: RegisterPairingToolsOptions,
): void {
  const { registry } = opts

  server.tool(
    "pair_offer",
    "Mint a one-time pairing offer and start listening for a client on the " +
      "rendezvous broker. Returns an `agentproto://pair?…` offer URL (share it / " +
      "render it as a QR), the daemon's identity fingerprint, and the offer " +
      "expiry. The URL is the bootstrap secret — it carries the daemon's public " +
      "keys (MITM-proof against the broker) and a short-lived single-use token. " +
      "The client runs `agentproto pair accept \"<url>\"`.",
    {
      ttlMinutes: z
        .number()
        .int()
        .min(1)
        .max(1440)
        .optional()
        .describe("Offer time-to-live in minutes (default 10)."),
      rendezvous: z
        .string()
        .optional()
        .describe(
          "Rendezvous WS URL to route through (ws:// or wss://). Defaults to " +
            "`pairing.rendezvous` from config.json, or the hosted broker " +
            "(wss://rdv.agentproto.sh/v1) when neither is set. The response's " +
            "`rendezvousIsHostedDefault` flags when that fallback applied.",
        ),
    },
    async ({ ttlMinutes, rendezvous }) => {
      const offer = await registry.createOffer({
        ...(ttlMinutes ? { ttlMs: ttlMinutes * 60_000 } : {}),
        ...(rendezvous ? { rendezvousUrl: rendezvous } : {}),
      })
      return text({
        url: offer.url,
        fingerprint: offer.fingerprint,
        rendezvous: offer.rendezvousUrl,
        rendezvousIsHostedDefault: offer.rendezvousIsHostedDefault,
        expiresAt: new Date(offer.exp * 1000).toISOString(),
      })
    },
  )

  server.tool(
    "pair_list",
    "List clients paired with this daemon: name, fingerprint, when first paired, " +
      "and last seen. Read-only.",
    {},
    async () => {
      const pairings = await registry.list()
      return text({
        pairings: pairings.map(p => ({
          name: p.name,
          fingerprint: p.fingerprint,
          createdAt: p.createdAt,
          lastSeen: p.lastSeen,
          rendezvous: p.rendezvousUrl,
        })),
      })
    },
  )

  server.tool(
    "pair_revoke",
    "Revoke a pairing by fingerprint or name. Drops its rendezvous connections " +
      "so the client can no longer reconnect, and removes it from pairings.json.",
    {
      target: z
        .string()
        .describe("The pairing's fingerprint or name (see pair_list)."),
    },
    async ({ target }) => {
      const revoked = await registry.revoke(target)
      return text(
        revoked
          ? { ok: true, revoked: target }
          : { ok: false, message: `no pairing matched "${target}"` },
      )
    },
  )
}
