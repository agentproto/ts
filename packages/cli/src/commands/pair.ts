/**
 * `agentproto pair <subcommand>` — E2E daemon pairing (design: DESIGN §6).
 *
 *   offer  [--ttl 10m] [--rendezvous wss://…] [--no-qr]   daemon side: mint an
 *          offer URL (+ QR) and start listening on the rendezvous.
 *   accept "<offer-url>" [--name <label>]                 client side: verify +
 *          persist the pairing.
 *   ls     [--json]                                       list pairings (daemon
 *          side via REST; falls back to the client store when no daemon).
 *   revoke <fingerprint|name>                             daemon side.
 *   exec   <fingerprint|name> -- <verb> [args…]           route any verb over the
 *          pairing's E2E channel (client routing).
 *
 * offer/ls/revoke round-trip the local daemon's `/pairings/*` REST routes (the
 * same surface the MCP `pair_*` tools drive); accept + exec run on the client.
 */

import { parseArgs } from "node:util"
import { spawn } from "node:child_process"
import {
  discoverDaemon,
  printNoDaemonError,
  httpGetJson,
  httpPostJson,
  httpDelete,
} from "./_daemon-helpers.js"
import {
  acceptOffer,
  openPairChannel,
  createLoopbackBridge,
} from "../util/pair-transport.js"
import {
  loadClientPairings,
  removeClientPairing,
  findClientPairing,
} from "../util/client-pairings.js"

const USAGE = `agentproto pair — end-to-end daemon pairing over an untrusted rendezvous

Usage:
  agentproto pair offer  [--ttl 10m] [--rendezvous <wss://…>] [--no-qr] [--json]
  agentproto pair accept "<offer-url>" [--name <label>]
  agentproto pair ls     [--json]
  agentproto pair revoke <fingerprint|name>
  agentproto pair exec   <fingerprint|name> -- <verb> [args…]
  agentproto pair --help

  offer   Daemon side: mint a single-use offer URL (+ QR) and start listening on
          the rendezvous. Share the URL with the client; it carries the daemon's
          public keys (MITM-proof) and a short-lived token.
  accept  Client side: verify the daemon's identity from the URL and persist the
          pairing to ~/.agentproto/pair-credentials.json.
  ls      List pairings. Uses the daemon's REST route when reachable; otherwise
          lists this machine's client-side pairings.
  revoke  Daemon side: drop a pairing so the client can no longer reconnect.
  exec    Client side: run any agentproto verb against the paired daemon over the
          E2E channel (e.g. \`agentproto pair exec my-laptop -- sessions ls\`).
`

export async function runPair(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE)
    return 0
  }
  const sub = args[0]
  switch (sub) {
    case "offer":
      return runOffer(args.slice(1))
    case "accept":
      return runAccept(args.slice(1))
    case "ls":
    case "list":
      return runLs(args.slice(1))
    case "revoke":
    case "rm":
      return runRevoke(args.slice(1))
    case "exec":
      return runExec(args.slice(1))
    case undefined:
      process.stdout.write(USAGE)
      return 0
    default:
      process.stderr.write(
        `agentproto pair: unknown subcommand "${sub}"\n  Known: offer | accept | ls | revoke | exec\n`,
      )
      return 2
  }
}

// ── offer ────────────────────────────────────────────────────────

async function runOffer(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      ttl: { type: "string" },
      rendezvous: { type: "string" },
      "no-qr": { type: "boolean" },
      json: { type: "boolean" },
    },
  })

  const report = await discoverDaemon()
  if (!report.found) {
    printNoDaemonError(report, "agentproto pair offer")
    return 2
  }
  const endpoint = report.found

  let ttlMinutes: number | undefined
  if (values.ttl) {
    const parsed = parseTtlMinutes(values.ttl)
    if (parsed === null) {
      process.stderr.write(`agentproto pair offer: invalid --ttl "${values.ttl}" (try 10m, 30s, 2h)\n`)
      return 2
    }
    ttlMinutes = parsed
  }

  const body: Record<string, unknown> = {}
  if (ttlMinutes !== undefined) body.ttlMinutes = ttlMinutes
  if (values.rendezvous) body.rendezvous = values.rendezvous

  let result: {
    url: string
    fingerprint: string
    rendezvous: string
    rendezvousIsHostedDefault?: boolean
    expiresAt: string
  }
  try {
    result = await httpPostJson(`${endpoint.url}/pairings/offer`, body, endpoint.token)
  } catch (err) {
    process.stderr.write(
      `agentproto pair offer: ${err instanceof Error ? err.message : String(err)}\n` +
        `  (Pass --rendezvous <wss://…> to route through a specific broker. If the\n` +
        `   daemon's pairing.rendezvous is set to "", that opt-out requires it.)\n`,
    )
    return 1
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
    return 0
  }

  process.stdout.write(
    `\nPairing offer (daemon ${result.fingerprint}) — expires ${result.expiresAt}\n\n` +
      `  ${result.url}\n\n`,
  )
  if (!values["no-qr"]) {
    await printQr(result.url)
  }
  const rvNote = result.rendezvousIsHostedDefault
    ? `The daemon is now relaying through ${result.rendezvous}\n` +
      `  (hosted default — the broker sees only ciphertext, never your traffic.\n` +
      `   Self-host with \`agentproto rendezvous serve\` and set pairing.rendezvous,\n` +
      `   or pass --rendezvous, to route elsewhere.)\n`
    : `The daemon is now listening on ${result.rendezvous}.\n`
  process.stdout.write(
    `On the other machine:\n` +
      `  agentproto pair accept "${result.url}"\n\n` +
      rvNote +
      `This window can close.\n`,
  )
  return 0
}

// ── accept ───────────────────────────────────────────────────────

async function runAccept(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { name: { type: "string" } },
  })
  const offerUrl = positionals[0]
  if (!offerUrl) {
    process.stderr.write(`agentproto pair accept: missing "<offer-url>".\n`)
    return 2
  }

  let result: Awaited<ReturnType<typeof acceptOffer>>
  try {
    result = await acceptOffer(offerUrl, values.name)
  } catch (err) {
    process.stderr.write(
      `agentproto pair accept: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  process.stdout.write(
    `\n✓ Paired with daemon ${result.fingerprint}\n` +
      `  name:       ${result.name}\n` +
      `  rendezvous: ${result.rendezvousUrl}\n\n` +
      `Confirm this fingerprint matches what the daemon showed at \`pair offer\`.\n` +
      `Run a verb over the pairing with:\n` +
      `  agentproto pair exec ${result.name} -- sessions ls\n`,
  )
  return 0
}

// ── ls ───────────────────────────────────────────────────────────

interface PairingRow {
  name: string
  fingerprint: string
  createdAt: string
  lastSeen: string
  rendezvous: string
}

async function runLs(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { json: { type: "boolean" } },
  })

  const report = await discoverDaemon()
  let rows: PairingRow[]
  let source: "daemon" | "client"
  if (report.found) {
    try {
      const body = await httpGetJson<{ pairings: PairingRow[] }>(`${report.found.url}/pairings`)
      rows = body.pairings ?? []
      source = "daemon"
    } catch {
      rows = await clientRows()
      source = "client"
    }
  } else {
    rows = await clientRows()
    source = "client"
  }

  if (values.json) {
    process.stdout.write(JSON.stringify({ source, pairings: rows }, null, 2) + "\n")
    return 0
  }
  if (rows.length === 0) {
    process.stdout.write(
      source === "daemon" ? "No pairings.\n" : "No client-side pairings on this machine.\n",
    )
    return 0
  }
  process.stdout.write(
    `${source === "client" ? "(client-side — no daemon reachable)\n" : ""}` +
      `${"NAME".padEnd(20)}  ${"FINGERPRINT".padEnd(18)}  ${"LAST SEEN".padEnd(22)}  RENDEZVOUS\n`,
  )
  for (const p of rows) {
    process.stdout.write(
      `${(p.name ?? "").slice(0, 20).padEnd(20)}  ${p.fingerprint.padEnd(18)}  ${(p.lastSeen ?? "").padEnd(22)}  ${p.rendezvous ?? ""}\n`,
    )
  }
  return 0
}

async function clientRows(): Promise<PairingRow[]> {
  const file = await loadClientPairings()
  return file.pairings.map(p => ({
    name: p.name,
    fingerprint: p.fingerprint,
    createdAt: p.createdAt,
    lastSeen: p.lastSeen,
    rendezvous: p.rendezvousUrl,
  }))
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
    process.stderr.write(`agentproto pair revoke: missing <fingerprint|name>.\n`)
    return 2
  }

  const report = await discoverDaemon()
  if (!report.found) {
    // No daemon: fall back to dropping the CLIENT-side record so this machine
    // stops trying to reconnect. (The daemon-side revoke needs a live daemon.)
    const removed = await removeClientPairing(target)
    if (!removed) {
      printNoDaemonError(report, "agentproto pair revoke")
      return 2
    }
    process.stdout.write(
      `Removed client-side pairing ${removed.fingerprint} (${removed.name}).\n` +
        `Note: no daemon was reachable, so only THIS machine's record was dropped.\n`,
    )
    return 0
  }

  try {
    await httpDelete(`${report.found.url}/pairings/${encodeURIComponent(target)}`, report.found.token)
  } catch (err) {
    process.stderr.write(
      `agentproto pair revoke: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }
  // Best-effort: also drop the client-side record if it lives here.
  await removeClientPairing(target).catch(() => {})
  process.stdout.write(`Revoked pairing "${target}".\n`)
  return 0
}

// ── exec (client routing) ────────────────────────────────────────

async function runExec(args: readonly string[]): Promise<number> {
  const dashDash = args.indexOf("--")
  const target = args[0]
  if (!target || target === "--") {
    process.stderr.write(
      `agentproto pair exec: usage: agentproto pair exec <fingerprint|name> -- <verb> [args…]\n`,
    )
    return 2
  }
  if (dashDash === -1 || dashDash + 1 >= args.length) {
    process.stderr.write(
      `agentproto pair exec: expected \`-- <verb> [args…]\` after the pairing name.\n`,
    )
    return 2
  }
  const childArgs = args.slice(dashDash + 1)

  const pairing = await findClientPairing(target)
  if (!pairing) {
    process.stderr.write(
      `agentproto pair exec: no client-side pairing "${target}". Run \`agentproto pair ls\`.\n`,
    )
    return 2
  }

  let channel: Awaited<ReturnType<typeof openPairChannel>>
  try {
    channel = await openPairChannel(pairing)
  } catch (err) {
    process.stderr.write(
      `agentproto pair exec: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  const bridge = await createLoopbackBridge(channel.client)
  try {
    const code = await runChild(childArgs, bridge.url)
    return code
  } finally {
    await bridge.close().catch(() => {})
    await channel.close().catch(() => {})
  }
}

/** Spawn `agentproto <childArgs>` with the daemon URL pointed at the loopback
 *  bridge, so the child discovers + drives the paired daemon transparently. */
function runChild(childArgs: readonly string[], daemonUrl: string): Promise<number> {
  const selfScript = process.argv[1]
  if (!selfScript) {
    // Without our own entry path we'd spawn Node with an empty script arg,
    // which resolves to the CWD and fails opaquely — surface it instead.
    return Promise.reject(
      new Error("cannot re-invoke the CLI: process.argv[1] is empty"),
    )
  }
  return new Promise(resolve => {
    const child = spawn(process.execPath, [selfScript, ...childArgs], {
      stdio: "inherit",
      env: {
        ...process.env,
        AGENTPROTO_DAEMON_URL: daemonUrl,
        // The bridge injects the daemon's own bearer on the far side, so the
        // child needs no token; clear any inherited one to avoid confusion.
        AGENTPROTO_DAEMON_TOKEN: "",
      },
    })
    child.once("exit", code => resolve(code ?? 0))
    child.once("error", () => resolve(1))
  })
}

// ── helpers ──────────────────────────────────────────────────────

/** Parse a TTL like `10m`, `30s`, `2h`, or a bare number of minutes. Returns
 *  minutes, or null when unparseable. */
function parseTtlMinutes(raw: string): number | null {
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)(s|m|h)?$/i)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const unit = (m[2] ?? "m").toLowerCase()
  const minutes = unit === "s" ? n / 60 : unit === "h" ? n * 60 : n
  return Math.max(1, Math.round(minutes))
}

/** Render the offer URL as an in-terminal QR (best-effort — prints nothing extra
 *  if the optional `qrcode-terminal` dep isn't available). */
async function printQr(url: string): Promise<void> {
  try {
    const mod = await import("qrcode-terminal")
    const qr = mod.default ?? mod
    await new Promise<void>(resolve => {
      qr.generate(url, { small: true }, (out: string) => {
        process.stdout.write(out + "\n")
        resolve()
      })
    })
  } catch {
    // qrcode-terminal not installed — the URL above is enough to pair.
  }
}
