import type { BrowserAdapterHandle, BrowserAdapterStartOptions, BrowserAdapterInstance } from "../types.js"
import { resolveLaunch } from "../lib/resolve-launch.js"
import { camofoxAdapter } from "./camofox.js"

function resolveBureauCmd(
  launchCmd: string | undefined,
  env: Record<string, string> | undefined
): { file: string; args: string[] } {
  const cmd = launchCmd ?? env?.BUREAU_SERVE_CMD ?? process.env.BUREAU_SERVE_CMD
  if (cmd) return { file: "/bin/sh", args: ["-c", cmd] }
  // Default: `bureau serve` assumed on PATH (installed globally or via the workspace bin).
  return { file: "bureau", args: ["serve"] }
}

export const bureauAdapter: BrowserAdapterHandle = {
  id: "bureau",
  name: "Bureau (Camofox + MCP capability server)",
  description:
    "Bureau capability server on :8830. Orchestrates Camofox headless first, then " +
    "spawns bureau serve which exposes browser tools as MCP-over-HTTP.",
  defaultPort: 8830,
  healthPath: "/health",

  location: "local",

  install: [
    {
      method: "path",
      // `bureau` CLI must be on PATH (e.g. installed via `npm i -g @agentik/bureau`
      // or linked from the monorepo workspace bin).
    },
  ],

  config: [
    // bureau inherits camofox's CAMOFOX_SERVE_CMD implicitly — camofoxAdapter.ensure
    // is called first inside `ensure` and reads that env var itself.
    {
      id: "bureau-serve-cmd",
      kind: "prompt",
      prompt: "Shell command to start bureau (leave blank to use `bureau serve` on PATH)",
      type: "text",
      persist: { env: "BUREAU_SERVE_CMD" },
    },
    {
      id: "bureau-port",
      kind: "prompt",
      prompt: "Port bureau should listen on",
      type: "text",
      default: "8830",
      persist: { env: "BUREAU_PORT" },
    },
  ],

  async ensure(opts: BrowserAdapterStartOptions): Promise<BrowserAdapterInstance> {
    const timeoutMs = opts.timeoutMs ?? 60_000
    const log = opts.log

    // Camofox must be up before bureau serve can start.
    const cam = await camofoxAdapter.ensure({
      port: opts.camofoxPort ?? 9377,
      launchCmd: undefined,
      env: opts.env,
      timeoutMs,
      log,
    })

    return resolveLaunch({
      handle: this,
      opts,
      label: "bureau",
      resolveLocalCmd: () => resolveBureauCmd(opts.launchCmd, opts.env),
      // PORT must reflect the resolved port — extraEnv receives it as a factory arg.
      extraEnv: (port) => ({
        CAMOFOX_URL: cam.baseUrl,
        PORT: String(port),
      }),
    })
  },
}
