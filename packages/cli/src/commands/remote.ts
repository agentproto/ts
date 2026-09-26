/**
 * `agentproto remote enable [--qr] [--provider quick] [--target-port <n>]
 *                            [--target-host <host>] [--json]`
 * `agentproto remote disable [--json]`
 * `agentproto remote status  [--json]`
 *
 * CLI twin of the MCP `remote_enable` / `remote_disable` / `remote_status`
 * tools (packages/runtime/src/remote-tools.ts) — same `RemoteController`
 * singleton on the daemon, driven over its `/remote/*` REST routes
 * (http-server.ts's `handleRemoteControl`). Discovers the daemon via the
 * same layered `discoverDaemon()` fallback as `agentproto tunnel` /
 * `agentproto sessions`.
 *
 * `--qr` renders `phoneUrl` (PHONE-PLAN.md P1.2) as an in-terminal QR code
 * so a phone can scan it straight into Control Center, or the hosted panel
 * when session-chat isn't installed — see `EnableResult.phoneUrl`'s doc in
 * remote-controller.ts for the two link shapes.
 */
import { parseArgs } from "node:util"
import type { EnableResult, RemoteStatus } from "@agentproto/runtime"
import {
  discoverDaemon,
  printNoDaemonError,
  httpPostJson,
  httpGetJson,
} from "./_daemon-helpers.js"
import { printQr } from "../util/qr.js"

const USAGE = `agentproto remote — publish this gateway to the internet via Cloudflare

Usage:
  agentproto remote enable  [--qr] [--provider quick] [--target-port <n>]
                            [--target-host <host>] [--json]
  agentproto remote disable [--json]
  agentproto remote status  [--json]

Discovers the daemon the same layered way \`agentproto tunnel\` / \`agentproto
sessions\` does — see \`agentproto sessions --help\` for the full fallback order.

enable  By default exposes the daemon's own gateway and gates it with a
        bearer token, shown ONCE — only its hash is persisted. Pass
        --target-port to tunnel a different local service instead (in that
        mode the daemon does not gate the traffic; the upstream handles its
        own auth). Re-running while a tunnel is already active errors — run
        \`agentproto remote disable\` first to rotate.
--qr    Print the response's \`phoneUrl\` as an in-terminal QR code (gateway
        mode only) — scan it to open Control Center (or the hosted panel,
        if session-chat isn't installed) straight from a phone.

Examples:
  agentproto remote enable --qr
  agentproto remote enable --target-port 5173   # tunnel a dev server instead
  agentproto remote status
  agentproto remote disable
`

export async function runRemote(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }

  const sub = args[0]
  if (sub === "enable") return runEnable(args.slice(1))
  if (sub === "disable") return runDisable(args.slice(1))
  if (sub === "status") return runStatus(args.slice(1))

  if (!sub) {
    process.stdout.write(USAGE)
    return 0
  }
  process.stderr.write(
    `agentproto remote: unknown subcommand "${sub}"\n` +
      `  Known: enable | disable | status\n`,
  )
  return 2
}

// ── enable ────────────────────────────────────────────────────────────

async function runEnable(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      qr: { type: "boolean" },
      provider: { type: "string" },
      "target-port": { type: "string" },
      "target-host": { type: "string" },
      json: { type: "boolean" },
    },
  })

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto remote enable")
    return 2
  }
  const endpoint = report.found

  const body: Record<string, unknown> = {}
  if (values.provider) body.provider = values.provider
  if (values["target-port"]) {
    const targetPort = Number.parseInt(values["target-port"], 10)
    if (!Number.isFinite(targetPort) || targetPort < 1 || targetPort > 65535) {
      process.stderr.write(
        `agentproto remote enable: --target-port must be 1-65535, got "${values["target-port"]}"\n`,
      )
      return 2
    }
    body.targetPort = targetPort
  }
  if (values["target-host"]) body.targetHost = values["target-host"]

  let result: EnableResult
  try {
    result = await httpPostJson<EnableResult>(
      `${endpoint.url}/remote/enable`,
      body,
      endpoint.token,
    )
  } catch (err) {
    process.stderr.write(
      `agentproto remote enable: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
  } else {
    process.stdout.write(`tunnel up  ${result.publicUrl}\n`)
    if (result.bearerToken) {
      process.stdout.write(
        `  bearer   ${result.bearerToken}  (shown once — only its hash is persisted)\n`,
      )
    }
    if (result.mcpEndpoint) process.stdout.write(`  mcp      ${result.mcpEndpoint}\n`)
    if (result.phoneUrl) process.stdout.write(`  phone    ${result.phoneUrl}\n`)
    if (result.warning) process.stdout.write(`  ${result.warning}\n`)
  }

  if (values.qr) {
    if (result.phoneUrl) {
      await printQr(result.phoneUrl)
    } else {
      process.stderr.write(
        "agentproto remote enable: --qr has nothing to render — no phoneUrl " +
          "(passthrough --target-port tunnels don't get one).\n",
      )
    }
  }

  return 0
}

// ── disable ───────────────────────────────────────────────────────────

async function runDisable(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { json: { type: "boolean" } },
  })

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto remote disable")
    return 2
  }
  const endpoint = report.found

  try {
    const result = await httpPostJson<{ disabled: boolean }>(
      `${endpoint.url}/remote/disable`,
      {},
      endpoint.token,
    )
    if (values.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    } else {
      process.stdout.write(result.disabled ? "tunnel disabled\n" : "no tunnel was active\n")
    }
    return 0
  } catch (err) {
    process.stderr.write(
      `agentproto remote disable: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }
}

// ── status ────────────────────────────────────────────────────────────

async function runStatus(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { json: { type: "boolean" } },
  })

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto remote status")
    return 2
  }
  const endpoint = report.found

  let status: RemoteStatus
  try {
    status = await httpGetJson<RemoteStatus>(`${endpoint.url}/remote/status`)
  } catch (err) {
    process.stderr.write(
      `agentproto remote status: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(status, null, 2) + "\n")
    return 0
  }

  if (!status.enabled) {
    process.stdout.write(
      `disabled${status.lastError ? `\n  last error  ${status.lastError}` : ""}\n`,
    )
    return 0
  }
  process.stdout.write(
    `enabled\n` +
      `  provider  ${status.provider}\n` +
      `  url       ${status.publicUrl}\n` +
      `  target    ${status.target?.host}:${status.target?.port}\n` +
      `  pid       ${status.pid ?? "—"}\n` +
      `  created   ${status.createdAt}\n` +
      (status.lastError ? `  error     ${status.lastError}\n` : ""),
  )
  return 0
}
