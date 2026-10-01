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
import {
  promptDeviceSession,
  type DevicePromptSessionsLike,
} from "./device-registry.js"
import type { HostRegistry } from "./host-registry.js"
import type { JoinTokenRegistry } from "./join-token-registry.js"

export interface RegisterDeviceToolsOptions {
  registry: DeviceRegistry
  /** Optional — the underlying host registry (`device_add`'s), when wired.
   *  `device_prompt` needs it directly: its wait-loop dials the host more
   *  than once, which `DeviceRegistry.forwardHttp`'s snapshot fallback
   *  would happily answer from cache. When absent, `device_prompt` is not
   *  registered. */
  hosts?: HostRegistry
  /** Optional (BOOTSTRAP P7a) — the session registry, for `device_prompt`
   *  to resolve a CONTROLLER session id onto its mapped HOST session id
   *  (the issue #1637 id split). Absent ⇒ no controller-id resolution and
   *  the tool keeps behaving exactly as before. */
  sessions?: DevicePromptSessionsLike
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
  const { registry, hosts: registryHosts, joinTokens, sessions } = opts

  server.tool(
    "device_list",
    "List devices known to this daemon: fingerprint, name, role " +
      "(client|host), kind (browser|cli|daemon, best-effort from the " +
      "client's self-reported name; always daemon for a host), rendezvous, " +
      "createdAt, lastSeen, scope (host, when granted via `pair offer " +
      "--host`), online (a channel/forward is active right now or a " +
      "recent contact succeeded), and for hosts lastProbeAt/lastError " +
      "(last contact attempt and why it failed). Joined CI hosts that are " +
      "gone (said goodbye, or unreachable past the TTL) are hidden unless " +
      "includeEnded is set; a manually added host unreachable past the TTL " +
      "shows stale: true. Read-only.",
    {
      includeEnded: z
        .boolean()
        .optional()
        .describe("Also list ended (gone) joined hosts, marked ended: true."),
    },
    async ({ includeEnded }) => {
      const devices = await registry.list({ includeEnded: includeEnded === true })
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
      "path device_add / `agentproto devices exec` uses. If the host is " +
      "offline, falls back to the last successful response for this exact " +
      "query (stale: true, capturedAt: when it was captured) instead of " +
      "failing outright — still rejects if there's nothing cached, or the " +
      "target isn't a registered host at all.",
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
        const staleFields = res.stale ? { stale: true as const, capturedAt: res.capturedAt } : {}
        if (res.status !== 200) {
          return text({ ok: false, status: res.status, message: body, ...staleFields })
        }
        return text({ ok: true, ...staleFields, ...(JSON.parse(body) as object) })
      } catch (err) {
        return text({ ok: false, message: err instanceof Error ? err.message : String(err) })
      }
    },
  )

  if (registryHosts) {
    server.tool(
      "device_prompt",
      "Send a prompt (a follow-up turn) to a session on a registered HOST " +
        "device — the write counterpart of device_sessions, forwarded live " +
        "over the host's E2E channel. sessionId accepts EITHER the host " +
        "session id or a local controller session id spawned with " +
        "`sandbox: \"device:<fp>\"` (P7a — the controller descriptor's " +
        "hostSessionId mapping is substituted when the exact id 404s). " +
        "Queueing rules are identical to a local agent_prompt: " +
        "fire-and-forget by default, queued behind the session's " +
        "in-flight turn, `interrupt`/`force` to redirect or jump the " +
        "queue. wait: true blocks until the prompted turn drains. " +
        "Requires the HOST daemon to have opted in (agentproto devices " +
        "allow-spawn on) over a host-scoped pairing — the same gate as " +
        "device spawn; refused for a plain remote-control pairing or an " +
        "unknown target.",
      {
        target: z.string().describe("The host's fingerprint or name (see device_list)."),
        sessionId: z
          .string()
          .min(1)
          .describe(
            "The session id ON the host — or a controller session id " +
              "spawned against `device:<fp>` (resolved via its hostSessionId).",
          ),
        prompt: z
          .union([z.string(), z.record(z.string(), z.unknown()), z.array(z.record(z.string(), z.unknown()))])
          .describe("Non-empty string, a content block, or an array of content blocks."),
        wait: z.boolean().optional().describe("Block until the prompted turn drains. Default false."),
        interrupt: z
          .boolean()
          .optional()
          .describe("Mid-turn: redirect instead of queueing (agent_prompt's interrupt). Default false."),
        force: z
          .boolean()
          .optional()
          .describe("Mid-turn: jump the FRONT of the FIFO (agent_prompt's force). Default false."),
        pollMs: z
          .number()
          .int()
          .min(10)
          .max(10_000)
          .optional()
          .describe("Poll cadence while waiting, ms. Default 1000. Each poll is a fresh E2E dial."),
        maxWaitMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Give up waiting after this long (ms). Default: wait forever."),
      },
      async ({ target, sessionId, prompt, wait, interrupt, force, pollMs, maxWaitMs }) => {
        try {
          const result = await promptDeviceSession(registryHosts, sessions, target, sessionId, {
            prompt,
            ...(wait ? { wait: true } : {}),
            ...(interrupt ? { interrupt: true } : {}),
            ...(force ? { force: true } : {}),
            ...(pollMs !== undefined ? { pollMs } : {}),
            ...(maxWaitMs !== undefined ? { maxWaitMs } : {}),
          })
          return text(result)
        } catch (err) {
          return text({ ok: false, message: err instanceof Error ? err.message : String(err) })
        }
      },
    )
  }

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
