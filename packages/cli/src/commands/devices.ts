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
 *   sessions <fingerprint|name> [--session <id>] [--lines <n>]
 *          a registered host's own session list, or (with --session) a
 *          tail of one session's output — read-only.
 *   join-token create|list|revoke   mint/manage AGENTPROTO_JOIN credentials
 *          (SANDBOX-VISIBILITY-JOIN) — see `agentproto devices join-token
 *          --help`.
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
  agentproto devices list   [--json] [--include-ended]
  agentproto devices rename <fingerprint|name> <new-name>
  agentproto devices revoke <fingerprint|name>
  agentproto devices add    <offer-url> [--name <label>]
  agentproto devices status <fingerprint|name>
  agentproto devices share-inference on|off
  agentproto devices allow-spawn on|off
  agentproto devices sessions <fingerprint|name> [--session <id>] [--lines <n>] [--clean] [--json]
  agentproto devices prompt <fingerprint|name> --session <id> --prompt <text> [--wait]
  agentproto devices join-token create|list|revoke ...  (see --help on that subcommand)
  agentproto devices --help

  list     Every device this daemon knows: name, fingerprint, role, kind,
           rendezvous, createdAt, lastSeen, online, scope. Joined CI hosts that
           are gone (said goodbye, or unreachable past the TTL) are hidden
           unless --include-ended.
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
  allow-spawn
           Opt THIS daemon in (or out) of being usable as an \`agent_start({
           sandbox: "device:<name>" })\` target — spawning/driving agent
           sessions here from a paired controller, over the same HOST-scoped
           pairing requirement as share-inference (a plain remote-control
           pairing never gets it). Default off. Writes
           features.deviceSpawnAllow to config.json — restart \`agentproto
           serve\` (or the daemon) for a change to take effect.
   sessions Read-only: a registered host's own session list, or (with
            --session) a tail of one session's output — forwarded live over
            the host's E2E channel.
   prompt   Send a follow-up turn to one of a registered host's sessions —
            the write counterpart of \`sessions\`. Queueing rules are
            identical to \`agentproto sessions prompt\`: fire-and-forget by
            default, queued behind an in-flight turn; --wait blocks until
            the turn drains. Requires the host to have opted in
            (\`agentproto devices allow-spawn on\`).
   join-token   Mint/list/revoke a long-lived, reusable AGENTPROTO_JOIN
            credential so a box daemon can auto-register as a host on boot,
            no offer URL to relay by hand.
`

const JOIN_TOKEN_USAGE = `agentproto devices join-token — manage AGENTPROTO_JOIN credentials

Usage:
  agentproto devices join-token create <name> [--ttl <duration>] [--max-uses <n>]
  agentproto devices join-token list   [--json]
  agentproto devices join-token revoke <id|name>

  create   Mint a token and print it ONCE — set it as a box daemon's
           AGENTPROTO_JOIN env var (e.g. a GitHub Actions secret). Never
           shown again by \`list\`.
             --ttl        Time-to-live, e.g. "90d" (default), "24h", "30m".
             --max-uses   Reuse ceiling (default: unlimited until --ttl/revoke).
  list     id, name, createdAt, expiresAt, maxUses, useCount, lastUsedAt,
           revokedAt — never the token's secret.
  revoke   Stop a token's standing accept loop. A box already joined through
           it keeps its host registration — \`agentproto devices revoke\` that
           device separately if you want it dropped too.
`

/** Parse a duration like "90d"/"24h"/"30m"/"45s" (or a bare integer, ms) into
 *  milliseconds. Returns undefined for an empty/unparseable string. */
function parseDurationMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const m = /^(\d+)(ms|s|m|h|d)?$/.exec(raw.trim())
  if (!m) return undefined
  const n = Number(m[1])
  const unit = (m[2] ?? "ms") as "ms" | "s" | "m" | "h" | "d"
  const factor: number = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]
  return n * factor
}

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
  ended?: boolean
  stale?: boolean
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
    case "allow-spawn":
      return runAllowSpawn(args.slice(1))
    case "sessions":
      return runSessions(args.slice(1))
    case "prompt":
      return runPrompt(args.slice(1))
    case "join-token":
      return runJoinToken(args.slice(1))
    case undefined:
      process.stdout.write(USAGE)
      return 0
    default:
      process.stderr.write(
        `agentproto devices: unknown subcommand "${sub}"\n  Known: list | rename | revoke | add | status | share-inference | allow-spawn | sessions | prompt | join-token\n`,
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
    options: { json: { type: "boolean" }, "include-ended": { type: "boolean" } },
  })

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto devices list")
    return 2
  }

  let rows: DeviceRow[]
  try {
    const body = await httpGetJson<{ devices: DeviceRow[] }>(`${report.found.url}/devices${values["include-ended"] ? "?includeEnded=1" : ""}`)
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
      `${(d.name ?? "").slice(0, 20).padEnd(20)}  ${d.fingerprint.padEnd(32)}  ${d.role.padEnd(6)}  ${d.kind.padEnd(8)}  ${(d.online ? "yes" : "no").padEnd(6)}  ${(d.lastSeen ?? "").padEnd(22)}  ${d.rendezvous ?? ""}${d.legacy ? "  [legacy: re-pair]" : ""}${d.scope === "host" ? "  [scope: host]" : ""}${d.ended ? "  [ended]" : ""}${d.stale ? "  [stale]" : ""}\n`,
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

// ── allow-spawn ──────────────────────────────────────────────────

async function runAllowSpawn(args: readonly string[]): Promise<number> {
  const mode = args[0]
  if (mode !== "on" && mode !== "off") {
    process.stderr.write(
      `agentproto devices allow-spawn: expected "on" or "off".\n` +
        "  Try: agentproto devices allow-spawn on\n",
    )
    return 2
  }
  const enabled = mode === "on"

  const cfg = await loadConfig()
  const next = setConfigKey(cfg, "features.deviceSpawnAllow", enabled)
  await saveConfig(next)

  process.stdout.write(
    `Device spawn allow: ${enabled ? "on" : "off"}.\n` +
      (enabled
        ? "This lets a paired controller spawn/drive agent sessions on this daemon\n" +
          "(`agent_start({ sandbox: \"device:<name>\" })`) — but ONLY over a pairing the\n" +
          "other side registered as a HOST (`agentproto pair offer --host` run here, then\n" +
          "`agentproto devices add` there); a plain remote-control pairing never gets it,\n" +
          "whatever this is set to.\n"
        : "") +
      "\nRestart `agentproto serve` (or the daemon) for this to take effect.\n",
  )
  return 0
}

// ── sessions ─────────────────────────────────────────────────────

async function runSessions(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      session: { type: "string" },
      lines: { type: "string" },
      clean: { type: "boolean" },
      json: { type: "boolean" },
    },
  })
  const target = positionals[0]
  if (!target) {
    process.stderr.write(`agentproto devices sessions: missing <fingerprint|name>.\n`)
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto devices sessions")
    return 2
  }

  const path = values.session
    ? `/devices/${encodeURIComponent(target)}/sessions/${encodeURIComponent(values.session)}/output?${new URLSearchParams(
        {
          ...(values.lines ? { lastN: values.lines } : {}),
          ...(values.clean ? { clean: "true" } : {}),
        },
      ).toString()}`
    : `/devices/${encodeURIComponent(target)}/sessions`

  let body: unknown
  try {
    body = await httpGetJson(`${report.found.url}${path}`)
  } catch (err) {
    process.stderr.write(
      `agentproto devices sessions: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(body, null, 2) + "\n")
    return 0
  }
  if (values.session) {
    const b = body as { lines?: string[]; status?: string; currentPhase?: string }
    process.stdout.write(`status: ${b.status ?? "?"}  phase: ${b.currentPhase ?? "?"}\n`)
    for (const line of b.lines ?? []) process.stdout.write(`${line}\n`)
    return 0
  }
  const sessions = Array.isArray(body) ? body : []
  if (sessions.length === 0) {
    process.stdout.write("No sessions on that host.\n")
    return 0
  }
  process.stdout.write(JSON.stringify(sessions, null, 2) + "\n")
  return 0
}

// ── prompt ───────────────────────────────────────────────────────

async function runPrompt(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      session: { type: "string" },
      prompt: { type: "string", short: "p" },
      wait: { type: "boolean" },
      interrupt: { type: "boolean" },
      force: { type: "boolean" },
      json: { type: "boolean" },
    },
  })
  const target = positionals[0]
  if (!target || !values.session || !values.prompt) {
    process.stderr.write(
      "agentproto devices prompt: missing <fingerprint|name>, --session or --prompt.\n" +
        "  Try: agentproto devices prompt <fp-or-name> --session <id> --prompt \"go check X\"\n" +
        "       agentproto devices prompt <fp-or-name> --session <id> --prompt \"...\" --wait\n",
    )
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto devices prompt")
    return 2
  }

  const url = `${report.found.url}/devices/${encodeURIComponent(target)}/sessions/${encodeURIComponent(
    values.session,
  )}/prompt${values.wait ? "?wait=true" : ""}`
  const body: Record<string, unknown> = { prompt: values.prompt }
  if (values.interrupt) body.interrupt = true
  if (values.force) body.force = true

  let result: Record<string, unknown>
  try {
    result = await httpPostJson<Record<string, unknown>>(url, body, report.found.token)
  } catch (err) {
    process.stderr.write(
      `agentproto devices prompt: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    return result.ok === true ? 0 : 1
  }
  if (result.ok !== true) {
    process.stderr.write(
      `agentproto devices prompt: ${typeof result.message === "string" ? result.message : JSON.stringify(result)}\n`,
    )
    return 1
  }
  if (values.wait) {
    const waitedMs = typeof result.waitedMs === "number" ? result.waitedMs : 0
    process.stdout.write(
      `agentproto devices prompt: turn complete on ${values.session} @ ${target} (${(waitedMs / 1000).toFixed(1)}s)\n`,
    )
  } else if (result.pending === true) {
    process.stdout.write(
      `agentproto devices prompt: queued for ${values.session} @ ${target}` +
        ` (position ${String(result.queuePosition)})\n`,
    )
  } else {
    process.stdout.write(`agentproto devices prompt: sent to ${values.session} @ ${target}\n`)
  }
  return 0
}

// ── join-token ───────────────────────────────────────────────────

async function runJoinToken(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(JOIN_TOKEN_USAGE)
    return 0
  }
  const sub = args[0]
  switch (sub) {
    case "create":
      return runJoinTokenCreate(args.slice(1))
    case "list":
    case "ls":
      return runJoinTokenList(args.slice(1))
    case "revoke":
    case "rm":
      return runJoinTokenRevoke(args.slice(1))
    case undefined:
      process.stdout.write(JOIN_TOKEN_USAGE)
      return 0
    default:
      process.stderr.write(
        `agentproto devices join-token: unknown subcommand "${sub}"\n  Known: create | list | revoke\n`,
      )
      return 2
  }
}

interface JoinTokenCreatedRow {
  id: string
  name: string
  token: string
  rendezvousUrl: string
  expiresAt: string
}

async function runJoinTokenCreate(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      ttl: { type: "string" },
      "max-uses": { type: "string" },
    },
  })
  const name = positionals[0]
  if (!name) {
    process.stderr.write(`agentproto devices join-token create: missing "<name>".\n`)
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto devices join-token create")
    return 2
  }

  const ttlMs = parseDurationMs(values.ttl)
  if (values.ttl && ttlMs === undefined) {
    process.stderr.write(`agentproto devices join-token create: bad --ttl "${values.ttl}" (e.g. "90d", "24h").\n`)
    return 2
  }
  const maxUses = values["max-uses"] ? Number.parseInt(values["max-uses"], 10) : undefined
  if (values["max-uses"] && (!Number.isFinite(maxUses) || (maxUses ?? 0) <= 0)) {
    process.stderr.write(`agentproto devices join-token create: bad --max-uses "${values["max-uses"]}".\n`)
    return 2
  }

  let result: JoinTokenCreatedRow
  try {
    const body: Record<string, unknown> = { name }
    if (ttlMs !== undefined) body.ttlMs = ttlMs
    if (maxUses !== undefined) body.maxUses = maxUses
    result = await httpPostJson(`${report.found.url}/devices/join-tokens`, body, report.found.token)
  } catch (err) {
    process.stderr.write(
      `agentproto devices join-token create: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  process.stdout.write(
    `\n✓ Created join token "${result.name}" (id ${result.id}, expires ${result.expiresAt})\n\n` +
      `Set this as the box daemon's AGENTPROTO_JOIN — shown ONCE, never again by \`list\`:\n\n` +
      `  ${result.token}\n\n` +
      `It will not be printed again. Revoke with:\n` +
      `  agentproto devices join-token revoke ${result.id}\n`,
  )
  return 0
}

interface JoinTokenRow {
  id: string
  name: string
  createdAt: string
  expiresAt: string
  maxUses?: number
  useCount: number
  lastUsedAt?: string
  revokedAt?: string
}

async function runJoinTokenList(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { json: { type: "boolean" } },
  })

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto devices join-token list")
    return 2
  }

  let rows: JoinTokenRow[]
  try {
    const body = await httpGetJson<{ tokens: JoinTokenRow[] }>(`${report.found.url}/devices/join-tokens`)
    rows = body.tokens ?? []
  } catch (err) {
    process.stderr.write(
      `agentproto devices join-token list: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify({ tokens: rows }, null, 2) + "\n")
    return 0
  }
  if (rows.length === 0) {
    process.stdout.write("No join tokens.\n")
    return 0
  }
  process.stdout.write(
    `${"NAME".padEnd(20)}  ${"ID".padEnd(14)}  ${"USES".padEnd(12)}  ${"EXPIRES".padEnd(22)}  STATUS\n`,
  )
  for (const t of rows) {
    const uses = `${t.useCount}${t.maxUses !== undefined ? `/${t.maxUses}` : ""}`
    const status = t.revokedAt ? "revoked" : Date.parse(t.expiresAt) <= Date.now() ? "expired" : "active"
    process.stdout.write(
      `${t.name.slice(0, 20).padEnd(20)}  ${t.id.padEnd(14)}  ${uses.padEnd(12)}  ${t.expiresAt.padEnd(22)}  ${status}\n`,
    )
  }
  return 0
}

async function runJoinTokenRevoke(args: readonly string[]): Promise<number> {
  const { positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {},
  })
  const target = positionals[0]
  if (!target) {
    process.stderr.write(`agentproto devices join-token revoke: missing <id|name>.\n`)
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto devices join-token revoke")
    return 2
  }

  try {
    await httpDelete(`${report.found.url}/devices/join-tokens/${encodeURIComponent(target)}`, report.found.token)
  } catch (err) {
    process.stderr.write(
      `agentproto devices join-token revoke: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }
  process.stdout.write(`Revoked join token "${target}".\n`)
  return 0
}
