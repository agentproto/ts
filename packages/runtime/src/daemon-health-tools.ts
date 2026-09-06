/**
 * MCP tool for a cheap, read-only daemon liveness probe.
 *
 * `daemon_health` returns the same data as `GET /health` but in-process:
 * no HTTP round-trip, no side effects. It is intended for orchestrating
 * clients that want an unambiguous "is the daemon still serving me?" check
 * without shelling out or firing a heavier operation.
 *
 * Because the tool only runs if the daemon that hosts it is alive and
 * serving MCP requests, the `alive` field is always `true` on a successful
 * return. The real failure mode this protects against is the client's
 * request itself failing or timing out at the transport level — observed as
 * a thrown/failed tool call, not as a `false` field in the response.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

export interface RegisterDaemonHealthToolsOptions {
  workspace: string
  registered: readonly string[]
  startedAt: number
  /** Effective value of the `daemon.resumeSessionsOnBoot` knob (§5, PR-4) —
   *  surfaced so an operator can confirm whether a restart will eagerly revive
   *  sessions or leave them dead-but-lazy-resumable. */
  resumeSessionsOnBoot: boolean
  /** Effective value of the `daemon.idleReapAfterMs` knob (PR-6) — the idle
   *  threshold (ms) after which the reaper retires an idle agent-cli session,
   *  or 0 when the reaper is off. Surfaced so an operator can confirm whether
   *  idle sessions are being retired (and thus kept out of eager resume). */
  idleReapAfterMs: number
  /** Effective value of the `daemon.crashDetectIntervalMs` knob (crash-detect
   *  PR-1) — the sweep interval (ms) the crash-detect pass runs on, or 0 when
   *  explicitly disabled. Detection is default-on, so this is normally a
   *  positive value even when the knob was never configured. Optional (unlike
   *  `idleReapAfterMs`) so a caller from before this knob existed still
   *  type-checks; defaults to 0 where consumed. */
  crashDetectIntervalMs?: number
  /** Effective value of the `daemon.restartSweepIntervalMs` knob (restart-
   *  scheduler PR-2) — the sweep cadence (ms) that EXECUTES an
   *  already-scheduled restart for a session carrying a `restartPolicy`, or
   *  0 when off (the default). Off doesn't disable per-session opt-in
   *  scheduling itself — it just leaves a stamped `nextRestartAt` inert.
   *  Optional (same shape as `crashDetectIntervalMs`) so a caller from
   *  before this knob existed still type-checks; defaults to 0 where
   *  consumed. */
  restartSweepIntervalMs?: number
  /** Effective value of the `daemon.turnStallAfterMs` knob (turn-liveness-
   *  watchdog chantier) — the silence threshold (ms) past which a busy,
   *  unblocked agent-cli session's turn is flagged stalled, or 0 when
   *  explicitly disabled. Detection is default-on, same shape as
   *  `crashDetectIntervalMs`, so this is normally a positive value even when
   *  the knob was never configured. Optional so a caller from before this
   *  knob existed still type-checks; defaults to 0 where consumed. */
  turnStallAfterMs?: number
  /** Daemon build version (the CLI's `__CLI_VERSION__` when served by
   *  `agentproto serve`). Mirrors `/health`'s field of the same name. */
  version?: string
  /** Build identity of the binary actually serving (sha + builtAt stamped
   *  at build time, source judged at serve time) — see GatewayOptions.build.
   *  Mirrors `/health`'s field of the same name; version alone can't
   *  distinguish a workspace dist from the published tarball. */
  build?: { sha?: string; builtAt?: string; source?: string }
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

export function registerDaemonHealthTools(
  server: McpServer,
  opts: RegisterDaemonHealthToolsOptions,
): void {
  server.tool(
    "daemon_health",
    "Cheap, side-effect-free liveness probe for this daemon. Returns the same " +
      "fields as GET /health but in-process. `alive` is always true when the tool " +
      "returns successfully; if the daemon is unreachable the failure is observed " +
      "as a thrown/failed tool call at the transport level, not as a false field.",
    {},
    async () => {
      return text({
        alive: true,
        status: "ok",
        workspace: opts.workspace,
        registered: opts.registered,
        uptimeMs: Date.now() - opts.startedAt,
        resumeSessionsOnBoot: opts.resumeSessionsOnBoot,
        idleReapAfterMs: opts.idleReapAfterMs,
        crashDetectIntervalMs: opts.crashDetectIntervalMs ?? 0,
        restartSweepIntervalMs: opts.restartSweepIntervalMs ?? 0,
        turnStallAfterMs: opts.turnStallAfterMs ?? 0,
        version: opts.version ?? null,
        build: opts.build ?? null,
      })
    },
  )
}
