/**
 * MCP tools over the device registry (DEVICES-PLAN PR-A) — `device_list` /
 * `device_rename` / `device_revoke`. A view on top of the same registry
 * `pair_offer`/`pair_list`/`pair_revoke` (pairing-tools.ts) drive; those keep
 * working unchanged. `device_revoke` has the exact effect of `pair_revoke`.
 *
 * Registered beside `pair_*` — same closure-rebind pattern; the registry
 * singleton lives on the gateway.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { DeviceRegistry } from "./device-registry.js"

export interface RegisterDeviceToolsOptions {
  registry: DeviceRegistry
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
  const { registry } = opts

  server.tool(
    "device_list",
    "List devices known to this daemon: fingerprint, name, role " +
      "(client|host — today always client), kind (browser|cli|daemon, " +
      "best-effort from the client's self-reported name), rendezvous, " +
      "createdAt, lastSeen, and online (a channel is served right now). " +
      "Read-only.",
    {},
    async () => {
      const devices = await registry.list()
      return text({ devices })
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
}
