/**
 * `agentproto devices <subcommand>` — the device registry view over the
 * daemon's paired clients (DEVICES-PLAN PR-A) and registered hosts
 * (reverse pairing, PR-C): role/kind/online layered on top of what
 * `agentproto pair ls` shows.
 *
 *   list                                     [--json]  every known device.
 *   rename <fingerprint|name> <new-name>                rename a device.
 *   revoke <fingerprint|name>                            drop a device (same
 *          daemon-side effect as `agentproto pair revoke`).
 *   add    <offer-url> [--name <label>]                 register a HOST from
 *          an offer minted with `agentproto pair offer --host`.
 *   status <fingerprint|name>                            probe a registered
 *          host's /health over its E2E channel.
 *
 * Pairing itself (`pair offer` / `pair accept`) still lives under
 * `agentproto pair` — this is the list/manage surface. All round-trip the
 * daemon's `/devices` REST routes (the same surface the MCP `device_*`
 * tools drive).
 */

import { parseArgs } from "node:util"
import {
  discoverDaemon,
  printNoDaemonError,
  httpGetJson,
  httpPostJson,
  httpPatchRaw,
  httpDelete,
} from "./_daemon-helpers.js"
import { loadConfig, saveConfig, setConfigKey } from "@agentproto/runtime/config"

const USAGE = `agentproto devices — manage devices known to this daemon

Usage:
  agentproto devices list   [--json]
  agentproto devices rename <fingerprint|name> <new-name>
  agentproto devices revoke <fingerprint|name>
  agentproto devices add    <offer-url> [--name <label>]
  agentproto devices status <fingerprint|name>
  agentproto devices share-inference on|off
  agentproto devices --help

  list     Every device this daemon knows: name, fingerprint, role, kind,
           rendezvous, createdAt, lastSeen, online, scope.
  rename   Give a device a new label (cosmetic only).
  revoke   Drop a device so it can no longer reconnect (same as
           \`agentproto pair revoke\`).
  add      Register a HOST from an offer URL minted with
           \`agentproto pair offer --host\` on the other machine. Refused if
           the offer isn't host-scoped (a plain \`pair offer\` only grants
           remote-control, not host registration).
  status   Probe a registered host's /health over its E2E channel — proof the
           host is reachable and driveable.
  share-inference
           Opt THIS daemon in (or out) of exposing its own local inference
           endpoint(s) — the llm-endpoint sidecar's /v1/models and
           /v1/chat/completions — to a paired controller, but ONLY over a
           pairing the OTHER side registered as a host (\`pair offer --host\`
           + \`devices add\`); a plain remote-control pairing never gets it,
           whatever this is set to. Default off. Writes
           features.deviceInferenceShare to config.json — restart
           \`agentproto serve\` (or the daemon) for a change to take effect.
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
  scope?: "host"
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
    case "add":
      return runAdd(args.slice(1))
    case "status":
      return runStatus(args.slice(1))
    case "share-inference":
      return runShareInference(args.slice(1))
    case undefined:
      process.stdout.write(USAGE)
      return 0
    default:
      process.stderr.write(
        `agentproto devices: unknown subcommand "${sub}"\n  Known: list | rename | revoke | add | status | share-inference\n`,
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
      `${(d.name ?? "").slice(0, 20).padEnd(20)}  ${d.fingerprint.padEnd(32)}  ${d.role.padEnd(6)}  ${d.kind.padEnd(8)}  ${(d.online ? "yes" : "no").padEnd(6)}  ${(d.lastSeen ?? "").padEnd(22)}  ${d.rendezvous ?? ""}${d.legacy ? "  [legacy: re-pair]" : ""}${d.scope === "host" ? "  [scope: host]" : ""}\n`,
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

// ── add ──────────────────────────────────────────────────────────

async function runAdd(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { name: { type: "string" } },
  })
  const offerUrl = positionals[0]
  if (!offerUrl) {
    process.stderr.write(`agentproto devices add: missing "<offer-url>".\n`)
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto devices add")
    return 2
  }

  let result: { fingerprint: string; name: string; rendezvousUrl: string }
  try {
    const body: Record<string, unknown> = { offerUrl }
    if (values.name) body.name = values.name
    result = await httpPostJson(`${report.found.url}/devices/add`, body, report.found.token)
  } catch (err) {
    process.stderr.write(
      `agentproto devices add: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  process.stdout.write(
    `\n✓ Added host ${result.fingerprint}\n` +
      `  name:       ${result.name}\n` +
      `  rendezvous: ${result.rendezvousUrl}\n\n` +
      `This device is now visible in \`agentproto devices list\` with role: host.\n` +
      `Probe it with:\n` +
      `  agentproto devices status ${result.name}\n`,
  )
  return 0
}

// ── status ───────────────────────────────────────────────────────

async function runStatus(args: readonly string[]): Promise<number> {
  const { positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {},
  })
  const target = positionals[0]
  if (!target) {
    process.stderr.write(`agentproto devices status: missing <fingerprint|name>.\n`)
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto devices status")
    return 2
  }

  let result: { status: number; headers: Record<string, string>; bodyBase64: string }
  try {
    result = await httpPostJson(
      `${report.found.url}/devices/${encodeURIComponent(target)}/exec`,
      { path: "/health" },
      report.found.token,
    )
  } catch (err) {
    process.stderr.write(
      `agentproto devices status: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  const body = Buffer.from(result.bodyBase64, "base64").toString("utf8")
  let parsed: unknown = body
  try {
    parsed = JSON.parse(body)
  } catch {
    /* not JSON — print raw */
  }
  process.stdout.write(
    `HTTP ${result.status}\n${typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2)}\n`,
  )
  return result.status >= 200 && result.status < 300 ? 0 : 1
}

// ── share-inference ─────────────────────────────────────────────────

async function runShareInference(args: readonly string[]): Promise<number> {
  const mode = args[0]
  if (mode !== "on" && mode !== "off") {
    process.stderr.write(
      `agentproto devices share-inference: expected "on" or "off".\n` +
        "  Try: agentproto devices share-inference on\n",
    )
    return 2
  }
  const enabled = mode === "on"

  const cfg = await loadConfig()
  const next = setConfigKey(cfg, "features.deviceInferenceShare", enabled)
  await saveConfig(next)

  const llmEndpointOn = next.features?.llmEndpoint === true
  process.stdout.write(
    `Device inference sharing: ${enabled ? "on" : "off"}.\n` +
      (enabled
        ? "This exposes this daemon's own local inference endpoint(s) (the llm-endpoint\n" +
          "sidecar's /v1/models + /v1/chat/completions) to a paired controller — but ONLY\n" +
          "over a pairing the other side registered as a HOST (`agentproto pair offer\n" +
          "--host` run here, then `agentproto devices add` there); a plain remote-control\n" +
          "pairing never gets it, whatever this is set to.\n" +
          (llmEndpointOn
            ? ""
            : "\nNote: features.llmEndpoint is not explicitly on — it defaults on once a named\n" +
              "endpoint is configured (`agentproto llm endpoints add`/`detect`), but until then\n" +
              "these routes 404. Check with `agentproto llm gateway status`.\n")
        : "") +
      "\nRestart `agentproto serve` (or the daemon) for this to take effect.\n",
  )
  return 0
}
