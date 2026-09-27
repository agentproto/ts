/**
 * `agentproto devices <subcommand>` — the device registry view over the
 * daemon's paired clients (DEVICES-PLAN PR-A): role/kind/online layered on
 * top of what `agentproto pair ls` shows.
 *
 *   list                                     [--json]  every known device.
 *   rename <fingerprint|name> <new-name>                rename a device.
 *   revoke <fingerprint|name>                            drop a device (same
 *          daemon-side effect as `agentproto pair revoke`).
 *
 * Pairing itself (`pair offer` / `pair accept`) still lives under
 * `agentproto pair` — this is the list/manage surface. All three round-trip
 * the daemon's `/devices` REST routes (the same surface the MCP `device_*`
 * tools drive).
 */

import { parseArgs } from "node:util"
import {
  discoverDaemon,
  printNoDaemonError,
  httpGetJson,
  httpPatchRaw,
  httpDelete,
} from "./_daemon-helpers.js"

const USAGE = `agentproto devices — manage devices known to this daemon

Usage:
  agentproto devices list   [--json]
  agentproto devices rename <fingerprint|name> <new-name>
  agentproto devices revoke <fingerprint|name>
  agentproto devices --help

  list     Every device this daemon knows: name, fingerprint, role, kind,
           rendezvous, createdAt, lastSeen, online.
  rename   Give a device a new label (cosmetic only).
  revoke   Drop a device so it can no longer reconnect (same as
           \`agentproto pair revoke\`).
`

interface DeviceRow {
  fingerprint: string
  name: string
  role: string
  kind: string
  rendezvous: string
  createdAt: string
  lastSeen: string
  online: boolean
  legacy?: boolean
}

export async function runDevices(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  const sub = args[0]
  switch (sub) {
    case "list":
    case "ls":
      return runList(args.slice(1))
    case "rename":
      return runRename(args.slice(1))
    case "revoke":
    case "rm":
      return runRevoke(args.slice(1))
    case undefined:
      process.stdout.write(USAGE)
      return 0
    default:
      process.stderr.write(
        `agentproto devices: unknown subcommand "${sub}"\n  Known: list | rename | revoke\n`,
      )
      return 2
  }
}

// ── list ─────────────────────────────────────────────────────────

async function runList(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { json: { type: "boolean" } },
  })

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto devices list")
    return 2
  }

  let rows: DeviceRow[]
  try {
    const body = await httpGetJson<{ devices: DeviceRow[] }>(`${report.found.url}/devices`)
    rows = body.devices ?? []
  } catch (err) {
    process.stderr.write(
      `agentproto devices list: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify({ devices: rows }, null, 2) + "\n")
    return 0
  }
  if (rows.length === 0) {
    process.stdout.write("No devices.\n")
    return 0
  }
  process.stdout.write(
    `${"NAME".padEnd(20)}  ${"FINGERPRINT".padEnd(32)}  ${"ROLE".padEnd(6)}  ${"KIND".padEnd(8)}  ${"ONLINE".padEnd(6)}  ${"LAST SEEN".padEnd(22)}  RENDEZVOUS\n`,
  )
  for (const d of rows) {
    process.stdout.write(
      `${(d.name ?? "").slice(0, 20).padEnd(20)}  ${d.fingerprint.padEnd(32)}  ${d.role.padEnd(6)}  ${d.kind.padEnd(8)}  ${(d.online ? "yes" : "no").padEnd(6)}  ${(d.lastSeen ?? "").padEnd(22)}  ${d.rendezvous ?? ""}${d.legacy ? "  [legacy: re-pair]" : ""}\n`,
    )
  }
  return 0
}

// ── rename ───────────────────────────────────────────────────────

async function runRename(args: readonly string[]): Promise<number> {
  const { positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {},
  })
  const target = positionals[0]
  const name = positionals[1]
  if (!target || !name) {
    process.stderr.write(
      `agentproto devices rename: usage: agentproto devices rename <fingerprint|name> <new-name>\n`,
    )
    return 2
  }
  if (positionals.length > 2) {
    process.stderr.write(`agentproto devices rename: unexpected extra positionals\n`)
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto devices rename")
    return 2
  }

  let result: { status: number; body: unknown }
  try {
    result = await httpPatchRaw(
      `${report.found.url}/devices/${encodeURIComponent(target)}`,
      { name },
      report.found.token,
    )
  } catch (err) {
    process.stderr.write(
      `agentproto devices rename: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }
  if (result.status < 200 || result.status >= 300) {
    const b = result.body
    const message =
      b && typeof b === "object" && "message" in b ? String((b as { message: unknown }).message) : JSON.stringify(b)
    process.stderr.write(`agentproto devices rename: ${message}\n`)
    return 1
  }
  process.stdout.write(`Renamed "${target}" to "${name}".\n`)
  return 0
}

// ── revoke ───────────────────────────────────────────────────────

async function runRevoke(args: readonly string[]): Promise<number> {
  const { positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {},
  })
  const target = positionals[0]
  if (!target) {
    process.stderr.write(`agentproto devices revoke: missing <fingerprint|name>.\n`)
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto devices revoke")
    return 2
  }

  try {
    await httpDelete(`${report.found.url}/devices/${encodeURIComponent(target)}`, report.found.token)
  } catch (err) {
    process.stderr.write(
      `agentproto devices revoke: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }
  process.stdout.write(`Revoked device "${target}".\n`)
  return 0
}
