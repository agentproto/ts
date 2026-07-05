/**
 * Named Cloudflare Tunnel provider — persistent-URL variant.
 *
 * Unlike the quick provider (ephemeral `*.trycloudflare.com`, fresh each
 * run), this runs a *named* cloudflared tunnel bound to a stable hostname
 * you control (e.g. `guilde-local.example.com`). The URL never changes —
 * which is what makes a tunnel survivable across restarts and safe to bake
 * into a client config (MCP server URL, webhook, …).
 *
 * ## BYO (bring-your-own) model
 *
 * This provider does NOT create the tunnel or its DNS record — it *runs* a
 * tunnel you've already provisioned once via the cloudflared CLI:
 *
 *   cloudflared tunnel create <name>            # → tunnel id + creds json
 *   cloudflared tunnel route dns <id> <host>    # → CNAME host → tunnel
 *
 * After that one-time setup, agentproto owns the lifecycle: it writes a
 * hermetic `--config` (tunnel id + credentials-file + a single ingress
 * rule `hostname → http://localhost:<port>`) and spawns
 * `cloudflared tunnel --config <ours> run <id>`. Because we pass our own
 * config, `~/.cloudflared/config.yml` is ignored entirely (same hermetic
 * reasoning as the quick provider) so the ingress rule always wins.
 *
 * Managed mode (provider auto-runs `create` + `route dns` via a CF API
 * token) is a future addition; BYO covers the common case without storing
 * an account-wide token.
 *
 * ## Why publicUrl is deterministic
 *
 * The hostname is known up front, so — unlike quick — we don't parse a URL
 * out of cloudflared's stderr. We instead wait for the connection-ready
 * marker (`Registered tunnel connection`) before reporting `active`, so a
 * tunnel that can't reach the edge surfaces as a start failure rather than
 * a dead "active" entry.
 *
 * ## credentials-file discovery
 *
 * If `credentialsFile` is omitted we default to
 * `~/.cloudflared/<tunnelId>.json` — exactly where `cloudflared tunnel
 * create` writes it. Pass an explicit path only if you relocated it.
 */

import type { ChildProcess } from "node:child_process"
import { promisify } from "node:util"
import { execFile } from "node:child_process"
import { mkdir, writeFile, rm, access } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { randomBytes } from "node:crypto"

import { spawnCloudflaredUntil } from "./cloudflared-spawn.js"
import type {
  ProviderStartOptions,
  ProviderStartResult,
  RemoteProvider,
  TunnelProviderHandle,
} from "./types.js"

const execFileAsync = promisify(execFile)

/** Cloudflared logs this once each edge connection is registered. */
const READY_REGEX = /Registered tunnel connection/i

const STARTUP_TIMEOUT_MS = 30_000

/** Adapter-kit slug for the named provider (catalog key). */
export const CLOUDFLARE_NAMED_SLUG = "cloudflare-named"

/** Named tunnels are stable, autostart-able, and require BYO credentials. */
export const NAMED_CAPABILITIES = {
  stableUrl: true,
  autostart: true,
  customDomain: true,
  requiresAuth: true,
  hasApi: false,
} as const

/** Creds fields the named provider accepts via `setup_tunnel_provider`. */
export const NAMED_SETUP_FIELDS = [
  {
    name: "hostname",
    description: "Cloudflare tunnel hostname (e.g. agent.example.com)",
    required: true,
    sensitive: true,
  },
  {
    name: "tunnelId",
    description:
      "Cloudflare tunnel UUID (e.g. 11111111-2222-3333-4444-555555555555)",
    required: true,
    sensitive: true,
  },
  {
    name: "credentialsFile",
    description: "Optional path to cloudflared credentials JSON file",
    required: false,
    sensitive: true,
  },
] as const

export interface NamedTunnelConfig {
  /** Stable public hostname routed to this tunnel (e.g. app.example.com). */
  hostname: string
  /** Cloudflare tunnel id or name (the `run` target). */
  tunnelId: string
  /**
   * Path to the tunnel credentials JSON. Defaults to
   * `~/.cloudflared/<tunnelId>.json`.
   */
  credentialsFile?: string
}

export function namedTunnelProvider(
  cfg: NamedTunnelConfig,
): RemoteProvider & TunnelProviderHandle {
  let child: ChildProcess | null = null
  let configPath: string | null = null
  let logFilePath: string | null = null
  let stopLogTail: (() => void) | null = null

  const credentialsFile =
    cfg.credentialsFile ??
    join(homedir(), ".cloudflared", `${cfg.tunnelId}.json`)

  return {
    id: "named",
    // ── adapter-kit handle surface ──────────────────────────────────
    slug: CLOUDFLARE_NAMED_SLUG,
    name: "Cloudflare Named Tunnel",
    // In-process provider — no npm package version to report.
    version: "builtin",
    description:
      "Persistent Cloudflare tunnel bound to a stable hostname you control (BYO credentials).",
    requiresSetup: true,
    capabilities: { ...NAMED_CAPABILITIES },
    setupFields: NAMED_SETUP_FIELDS,
    async check(): Promise<boolean> {
      // Reachable = cloudflared on PATH AND the tunnel credentials file
      // exists. NOT called during listing (kit derives status from creds
      // existence); reserved for on-demand health probes.
      const [bin, creds] = await Promise.all([
        cloudflaredOnPath(),
        fileExists(credentialsFile),
      ])
      return bin && creds
    },
    async start(opts: ProviderStartOptions): Promise<ProviderStartResult> {
      await assertCloudflaredOnPath()
      await assertCredentialsExist(credentialsFile)

      const targetUrl = `http://${opts.target.host}:${opts.target.port}`

      // Hermetic per-run config. A named tunnel needs a real `ingress:`
      // block (the quick provider deliberately omits it because `--url`
      // is its routing source of truth; here `run <id>` has no `--url`,
      // so ingress IS the routing). Random suffix avoids collisions when
      // restarts overlap.
      const id = randomBytes(4).toString("hex")
      const dir = join(opts.workspace, ".agentproto")
      await mkdir(dir, { recursive: true })
      configPath = join(dir, `cloudflared-named-${id}.yml`)
      const configBody = [
        `# generated by agentproto-runtime — named tunnel run config`,
        `# hermetic: overrides ~/.cloudflared/config.yml. Safe to delete`,
        `# when the tunnel is down.`,
        `tunnel: ${cfg.tunnelId}`,
        `credentials-file: ${credentialsFile}`,
        `no-autoupdate: true`,
        ``,
        `ingress:`,
        `  - hostname: ${cfg.hostname}`,
        `    service: ${targetUrl}`,
        `  - service: http_status:404`,
        ``,
      ].join("\n")
      await writeFile(configPath, configBody, "utf8")

      // cloudflared's stdout+stderr are redirected to this file rather than
      // a pipe — see cloudflared-spawn.ts for why (stdio back-pressure
      // wedges the tunnel when spawned under a busy host event loop).
      const logPath = join(dir, `cloudflared-named-${id}.log`)
      logFilePath = logPath

      const { proc, stopTail } = await spawnCloudflaredUntil(
        ["tunnel", "--config", configPath, "run", cfg.tunnelId],
        {
          logPath,
          readyRegex: READY_REGEX,
          timeoutMs: STARTUP_TIMEOUT_MS,
          timeoutMessage: `cloudflared did not register a tunnel connection within ${STARTUP_TIMEOUT_MS / 1000}s`,
          onLog: opts.onLog,
        },
      )
      child = proc
      stopLogTail = stopTail

      proc.once("exit", (code, signal) => {
        opts.onLog?.(
          `[cloudflared] exited (code=${code ?? "?"} signal=${signal ?? "-"})`,
        )
      })

      return { publicUrl: `https://${cfg.hostname}`, pid: proc.pid ?? null }
    },

    async stop(): Promise<void> {
      const proc = child
      const cfg2 = configPath
      const log = logFilePath
      const stopTail = stopLogTail
      child = null
      configPath = null
      logFilePath = null
      stopLogTail = null
      // Stop the background log-forwarder before killing cloudflared.
      stopTail?.()
      if (cfg2) {
        try {
          await rm(cfg2, { force: true })
        } catch {
          /* noop */
        }
      }
      if (log) {
        try {
          await rm(log, { force: true })
        } catch {
          /* noop */
        }
      }
      if (!proc || proc.exitCode !== null) return
      proc.kill("SIGTERM")
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL")
        } catch {
          /* noop */
        }
      }, 3_000)
      timer.unref()
      await new Promise<void>(resolve => {
        if (proc.exitCode !== null) {
          clearTimeout(timer)
          resolve()
          return
        }
        proc.once("exit", () => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
  }
}

/** Non-throwing PATH probe for the adapter-kit `check()` health surface. */
async function cloudflaredOnPath(): Promise<boolean> {
  try {
    await execFileAsync("cloudflared", ["--version"], { timeout: 3_000 })
    return true
  } catch {
    return false
  }
}

/** Non-throwing existence check (no value read — purely a boolean probe). */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function assertCloudflaredOnPath(): Promise<void> {
  try {
    await execFileAsync("cloudflared", ["--version"], { timeout: 3_000 })
  } catch {
    throw new Error(
      "cloudflared not found on PATH. Install it first:\n" +
        "  macOS:    brew install cloudflared\n" +
        "  Linux:    https://pkg.cloudflare.com/index.html\n" +
        "  Windows:  winget install --id Cloudflare.cloudflared\n" +
        "Or download a prebuilt binary from https://github.com/cloudflare/cloudflared/releases.",
    )
  }
}

async function assertCredentialsExist(path: string): Promise<void> {
  try {
    await access(path)
  } catch {
    throw new Error(
      `named tunnel credentials not found at ${path}.\n` +
        "Provision the tunnel once, then retry:\n" +
        "  cloudflared tunnel create <name>\n" +
        "  cloudflared tunnel route dns <id-or-name> <hostname>\n" +
        "Or pass an explicit credentialsFile if you relocated the JSON.",
    )
  }
}
