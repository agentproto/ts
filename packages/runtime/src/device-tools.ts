/**
 * MCP tools over the device registry (DEVICES-PLAN PR-A/PR-C) — `device_list`
 * / `device_rename` / `device_revoke` / `device_add`. A view on top of the
 * same registries `pair_offer`/`pair_list`/`pair_revoke` (pairing-tools.ts)
 * and host-registry.ts drive; those keep working unchanged. `device_revoke`
 * has the exact effect of `pair_revoke` for a client device.
 *
 * `device_add` (PR-C) registers a HOST from a `--host`-scoped offer URL —
 * see `HostRegistry.add`'s scope gate (host-registry.ts). It requires the
 * gateway to have wired a `HostRegistry` into the `DeviceRegistry`; without
 * one the call rejects with a clear message rather than a missing-tool error
 * (this repo always wires one when `pairingRegistry` is wired, so that's
 * only reachable via a deliberate host misconfiguration).
 *
 * Registered beside `pair_*` — same closure-rebind pattern; the registry
 * singleton lives on the gateway.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { DeviceRegistry } from "./device-registry.js"
import type { JoinTokenRegistry } from "./join-token-registry.js"

export interface RegisterDeviceToolsOptions {
  registry: DeviceRegistry
  /** Optional (SANDBOX-VISIBILITY-JOIN) — when wired, registers
   *  `join_token_create`/`join_token_list`/`join_token_revoke`. */
  joinTokens?: JoinTokenRegistry
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

export function registerDeviceTools(
  server: McpServer,
  opts: RegisterDeviceToolsOptions,
): void {
  const { registry, joinTokens } = opts

  server.tool(
    "device_list",
    "List devices known to this daemon: fingerprint, name, role " +
      "(client|host), kind (browser|cli|daemon, best-effort from the " +
      "client's self-reported name; always daemon for a host), rendezvous, " +
      "createdAt, lastSeen, scope (host, when granted via `pair offer " +
      "--host`), and online (a channel/forward is active right now). " +
      "Read-only.",
    {},
    async () => {
      const devices = await registry.list()
      return text({ devices })
    },
  )

  server.tool(
    "device_add",
    "Register a HOST from a pairing offer URL minted with `agentproto pair " +
      "offer --host` on the other machine — after this, device_status / " +
      "`agentproto devices status|exec` can drive it. Refuses (no dial " +
      "attempted) an offer that isn't host-scoped: a plain `pair offer` " +
      "grants remote-control only, not host registration.",
    {
      offerUrl: z.string().describe("The `agentproto://pair?…` offer URL, minted with --host."),
      name: z.string().optional().describe("Label for this host (default: its fingerprint)."),
    },
    async ({ offerUrl, name }) => {
      try {
        const result = await registry.add(offerUrl, name)
        return text({ ok: true, ...result })
      } catch (err) {
        return text({ ok: false, message: err instanceof Error ? err.message : String(err) })
      }
    },
  )

  server.tool(
    "device_rename",
    "Rename a device (fingerprint or its current name) to a new label. " +
      "Cosmetic only — no effect on pairing or auth.",
    {
      target: z
        .string()
        .describe("The device's fingerprint or current name (see device_list)."),
      name: z.string().min(1).describe("The new name."),
    },
    async ({ target, name }) => {
      const renamed = await registry.rename(target, name)
      return text(
        renamed
          ? { ok: true, target, name }
          : { ok: false, message: `no device matched "${target}"` },
      )
    },
  )

  server.tool(
    "device_revoke",
    "Revoke a device by fingerprint or name — drops its rendezvous " +
      "connections so it can no longer reconnect. Same effect as pair_revoke.",
    {
      target: z
        .string()
        .describe("The device's fingerprint or name (see device_list)."),
    },
    async ({ target }) => {
      const revoked = await registry.revoke(target)
      return text(
        revoked
          ? { ok: true, revoked: target }
          : { ok: false, message: `no device matched "${target}"` },
      )
    },
  )

  server.tool(
    "device_sessions",
    "Read-only: a registered HOST device's own session list (compact), or " +
      "(with sessionId) a tail of one session's output — forwarded live " +
      "over the host's E2E channel (HostRegistry.forwardHttp), the same " +
      "path device_add / `agentproto devices exec` uses. Rejects if the " +
      "target isn't a registered host.",
    {
      target: z.string().describe("The host's fingerprint or name (see device_list)."),
      sessionId: z
        .string()
        .optional()
        .describe("Tail this session's output instead of listing all sessions."),
      lastN: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Max output lines to return (with sessionId). Default 80, max 500."),
      clean: z
        .boolean()
        .optional()
        .describe("Strip ANSI codes and drop framing lines (with sessionId)."),
    },
    async ({ target, sessionId, lastN, clean }) => {
      const path = sessionId
        ? `/sessions/${encodeURIComponent(sessionId)}/output?${new URLSearchParams({
            ...(lastN !== undefined ? { lastN: String(lastN) } : {}),
            ...(clean ? { clean: "true" } : {}),
          }).toString()}`
        : "/sessions"
      try {
        const res = await registry.forwardHttp(target, { method: "GET", path })
        const body = Buffer.from(res.body).toString("utf8")
        if (res.status !== 200) {
          return text({ ok: false, status: res.status, message: body })
        }
        return text({ ok: true, ...(JSON.parse(body) as object) })
      } catch (err) {
        return text({ ok: false, message: err instanceof Error ? err.message : String(err) })
      }
    },
  )

  if (joinTokens) {
    server.tool(
      "join_token_create",
      "Mint a long-lived, revocable, reusable join token: a value for a box " +
        "daemon's AGENTPROTO_JOIN env var so it auto-registers as a host on " +
        "boot, no offer URL to relay by hand. Shown ONCE — never persisted " +
        "or echoed again by join_token_list.",
      {
        name: z.string().min(1).describe('Label for this token (e.g. "ci-reviewer").'),
        ttlMs: z.number().int().positive().optional().describe("Time-to-live in ms. Default 90 days."),
        maxUses: z.number().int().positive().optional().describe("Reuse ceiling. Default unlimited."),
      },
      async ({ name, ttlMs, maxUses }) => {
        try {
          const created = await joinTokens.create({
            name,
            ...(ttlMs !== undefined ? { ttlMs } : {}),
            ...(maxUses !== undefined ? { maxUses } : {}),
          })
          return text({ ok: true, ...created })
        } catch (err) {
          return text({ ok: false, message: err instanceof Error ? err.message : String(err) })
        }
      },
    )

    server.tool(
      "join_token_list",
      "List join tokens: id, name, createdAt, expiresAt, maxUses, useCount, " +
        "lastUsedAt, revokedAt. Never returns the token's secret. Read-only.",
      {},
      async () => text({ tokens: await joinTokens.list() }),
    )

    server.tool(
      "join_token_revoke",
      "Revoke a join token by id or name — stops its standing accept loop; " +
        "a box already joined through it keeps its host registration (revoke " +
        "the device itself via device_revoke to drop that too).",
      { target: z.string().describe("The token's id or name (see join_token_list).") },
      async ({ target }) => {
        const revoked = await joinTokens.revoke(target)
        return text(
          revoked
            ? { ok: true, revoked: target }
            : { ok: false, message: `no join token matched "${target}"` },
        )
      },
    )
  }
}
