/**
 * Ngrok tunnel provider — static-domain variant.
 *
 * Spawns `ngrok http <port>` (with optional `--domain=<domain>` when a
 * reserved domain is configured), authenticates via the stored authtoken,
 * and extracts the public URL from the local ngrok agent API
 * (`http://127.0.0.1:4040/api/tunnels`) with a fallback to parsing stdout
 * JSON lines.
 *
 * ## Creds model
 *
 * Ngrok needs an authtoken (free tier ok). An optional reserved domain
 * (`--domain`) enables stable URLs (paid plan). Both are stored via the
 * adapter-kit creds store under the tunnel family.
 *
 * ## local agent API (port 4040)
 *
 * Ngrok exposes `http://127.0.0.1:4040/api/tunnels` while running — the
 * canonical source of the public URL. We poll this after spawn (with a
 * short grace period) before falling back to stdout JSON-line parsing.
 *
 * ## Why we don't use `@ngrok/ngrok` npm package
 *
 * The npm package embeds the ngrok binary and manages its own lifecycle,
 * which fights with our explicit spawn/stop model. The binary-on-PATH
 * approach mirrors the cloudflared providers and keeps the dependency
 * surface small.
 *
 * ## ngrok discovery
 *
 * Detected on PATH at check/start time. Missing → `check()` returns false
 * and `start()` throws with install instructions. We deliberately don't
 * bundle binaries.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { promisify } from "node:util"
import { execFile } from "node:child_process"

import type {
  ProviderStartOptions,
  ProviderStartResult,
  RemoteProvider,
  TunnelProviderHandle,
} from "./types.js"

const execFileAsync = promisify(execFile)

/** JSON line from ngrok's `--log-format=json` stdout: `{"url":"...",...}`. */
const URL_JSON_REGEX = /"url"\s*:\s*"(https:\/\/[^"]+)"/i

/** Ngrok local agent API base. */
const AGENT_API = "http://127.0.0.1:4040"

const STARTUP_TIMEOUT_MS = 30_000
const API_POLL_INTERVAL_MS = 500
const API_GRACE_MS = 2_000

/** Adapter-kit slug for the ngrok provider (catalog key). */
export const NGROK_SLUG = "ngrok"

/**
 * Ngrok capabilities. `stableUrl` is true only when a reserved domain is
 * configured; without one the URL is fixed in format but not guaranteed
 * across restarts without a paid plan.
 */
export const NGROK_CAPABILITIES = {
  stableUrl: false, // overridden at instance level when domain is set
  autostart: true,
  customDomain: true,
  requiresAuth: true,
  hasApi: true,
} as const

/** Creds fields the ngrok provider accepts via `setup_tunnel_provider`. */
export const NGROK_SETUP_FIELDS = [
  {
    name: "authToken",
    description:
      "Ngrok authtoken (from dashboard.ngrok.com/get-started/your-authtoken)",
    required: true,
    sensitive: true,
  },
  {
    name: "domain",
    description: "Optional reserved ngrok static domain (requires paid plan)",
    required: false,
    sensitive: true,
  },
] as const

/** Structured credentials for the ngrok provider. */
export interface TunnelNgrokCreds {
  /** Ngrok authtoken from dashboard.ngrok.com/get-started/your-authtoken. */
  authToken: string
  /** Optional reserved static domain (requires ngrok paid plan). */
  domain?: string
}

/** Factory options for building an ngrok tunnel provider. */
export interface NgrokProviderOpts {
  /** Ngrok authtoken. Pass undefined for descriptor-only handles. */
  authToken?: string
  /** Optional reserved static domain. */
  domain?: string
  /**
   * Binary presence probe. Default: real `ngrok version` PATH check.
   * Injectable so tests can control binary-presence deterministically
   * without a global `node:child_process` mock.
   */
  probeBinary?: () => Promise<boolean>
}

/**
 * Factory: build an ngrok tunnel provider.
 *
 * When called with no config (descriptor-only, for listing), `start()` and
 * `check()` will fail gracefully — the adapter-kit lister never calls those
 * methods; it only inspects handle metadata.
 */
export function ngrokTunnelProvider(
  opts?: NgrokProviderOpts,
): RemoteProvider & TunnelProviderHandle {
  let child: ChildProcess | null = null

  const authToken = opts?.authToken ?? null
  const domain = opts?.domain ?? null
  const hasDomain = domain != null && domain.length > 0
  const probeBinary = opts?.probeBinary ?? ngrokOnPath

  return {
    id: "ngrok",
    // ── adapter-kit handle surface ──────────────────────────────────
    slug: NGROK_SLUG,
    name: "Ngrok Tunnel",
    version: "builtin",
    description:
      "Ngrok tunnel with optional static domain support. Requires a free authtoken.",
    requiresSetup: true,
    setupFields: NGROK_SETUP_FIELDS,
    capabilities: {
      ...NGROK_CAPABILITIES,
      stableUrl: hasDomain,
    },
    async check(): Promise<boolean> {
      // Reachable = ngrok binary on PATH AND an authtoken is available.
      const [bin] = await Promise.all([probeBinary()])
      return bin && authToken != null
    },
    async start(opts: ProviderStartOptions): Promise<ProviderStartResult> {
      await assertNgrokOnPath(probeBinary)
      if (!authToken) {
        throw new Error(
          "ngrok authtoken not configured. Run setup first:\n" +
            "  agentproto tunnel setup ngrok\n" +
            "Or set NGROK_AUTHTOKEN in your environment.",
        )
      }

      const args = [
        "http",
        String(opts.target.port),
        "--log=stdout",
        "--log-format=json",
      ]
      if (hasDomain) args.push(`--domain=${domain}`)

      const proc = spawn("ngrok", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NGROK_AUTHTOKEN: authToken },
        shell: false,
      })
      child = proc

      // Forward logs.
      const forwardLogs = (chunk: Buffer) => {
        const text = chunk.toString("utf8")
        for (const line of text.split(/\r?\n/)) {
          if (line.length > 0) opts.onLog?.(`[ngrok] ${line}`)
        }
      }
      proc.stderr?.on("data", forwardLogs)
      proc.stdout?.on("data", forwardLogs)

      const url = await new Promise<string>((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          try {
            proc.kill("SIGTERM")
          } catch {
            /* noop */
          }
          reject(
            new Error(
              `ngrok did not emit a public URL within ${STARTUP_TIMEOUT_MS / 1000}s`,
            ),
          )
        }, STARTUP_TIMEOUT_MS)

        // Strategy 1: poll the local agent API (preferred — canonical).
        let apiPollHandle: ReturnType<typeof setInterval> | null = null
        const startApiPoll = () => {
          apiPollHandle = setInterval(async () => {
            if (settled) return
            try {
              const res = await fetch(`${AGENT_API}/api/tunnels`)
              if (!res.ok) return
              const data = (await res.json()) as {
                tunnels?: { public_url?: string }[]
              }
              const pubUrl = data.tunnels?.[0]?.public_url
              if (pubUrl) {
                settled = true
                clearTimeout(timer)
                if (apiPollHandle) clearInterval(apiPollHandle)
                resolve(pubUrl)
              }
            } catch {
              // API not ready yet — keep polling.
            }
          }, API_POLL_INTERVAL_MS)
          if (apiPollHandle.unref) apiPollHandle.unref()
        }

        // Strategy 2: fallback — parse JSON lines from stdout.
        const onStdout = (chunk: Buffer) => {
          if (settled) return
          const text = chunk.toString("utf8")
          // Try the regex first (fast path).
          const reMatch = text.match(URL_JSON_REGEX)
          if (reMatch) {
            settled = true
            clearTimeout(timer)
            if (apiPollHandle) clearInterval(apiPollHandle)
            resolve(reMatch[1]!)
            return
          }
          // Try line-by-line JSON parse.
          for (const line of text.split(/\r?\n/)) {
            if (line.length === 0) continue
            try {
              const parsed = JSON.parse(line) as { url?: string }
              if (parsed.url) {
                settled = true
                clearTimeout(timer)
                if (apiPollHandle) clearInterval(apiPollHandle)
                resolve(parsed.url)
                return
              }
            } catch {
              // Not a JSON line — keep waiting.
            }
          }
        }

        // Start API polling after a short grace period (ngrok takes ~1-2s
        // to start the agent API).
        setTimeout(startApiPoll, API_GRACE_MS)

        // Also listen on stdout for JSON-line fallback.
        proc.stdout?.on("data", onStdout)

        proc.once("error", err => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (apiPollHandle) clearInterval(apiPollHandle)
          reject(err)
        })
        proc.once("exit", (code, signal) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (apiPollHandle) clearInterval(apiPollHandle)
          reject(
            new Error(
              `ngrok exited before emitting a URL (code=${code}, signal=${signal})`,
            ),
          )
        })
      })

      proc.once("exit", (code, signal) => {
        opts.onLog?.(
          `[ngrok] exited (code=${code ?? "?"} signal=${signal ?? "-"})`,
        )
      })

      return { publicUrl: url, pid: proc.pid ?? null }
    },

    async stop(): Promise<void> {
      const proc = child
      child = null
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

// ── helpers ────────────────────────────────────────────────────────────

/** Non-throwing PATH probe for the adapter-kit `check()` health surface. */
async function ngrokOnPath(): Promise<boolean> {
  try {
    await execFileAsync("ngrok", ["version"], { timeout: 3_000 })
    return true
  } catch {
    return false
  }
}

async function assertNgrokOnPath(probe?: () => Promise<boolean>): Promise<void> {
  const ok = await (probe ?? ngrokOnPath)()
  if (!ok) {
    throw new Error(
      "ngrok not found on PATH. Install it first:\n" +
        "  macOS:    brew install ngrok/ngrok/ngrok\n" +
        "  Linux:    https://ngrok.com/download\n" +
        "  Windows:  winget install ngrok\n" +
        "Or download a prebuilt binary from https://ngrok.com/download.",
    )
  }
}