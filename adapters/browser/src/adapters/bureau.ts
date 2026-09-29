import { camofox } from "@agentproto/adapter-browser-camofox"
import { createProcessProvider } from "../providers/process-provider.js"
import { toAdapterHandle } from "../providers/to-adapter-handle.js"
import type { BrowserAdapterHandle } from "../types.js"

function resolveBureauCmd(
  launchCmd: string | undefined,
  env: Record<string, string> | undefined
): { file: string; args: string[] } {
  const cmd = launchCmd ?? env?.BUREAU_SERVE_CMD ?? process.env.BUREAU_SERVE_CMD
  if (cmd) return { file: "/bin/sh", args: ["-c", cmd] }
  // Default: `bureau serve` assumed on PATH (installed globally or via the workspace bin).
  return { file: "bureau", args: ["serve"] }
}

export const bureauProvider = createProcessProvider({
  id: "bureau",
  name: "Bureau (Camofox + MCP capability server)",
  description:
    "Bureau capability server on :8830. Orchestrates Camofox headless first, then " +
    "spawns bureau serve which exposes browser tools as MCP-over-HTTP.",
  defaultPort: 8830,
  healthPath: "/health",
  install: [{ method: "path" }],
  config: [
    // bureau inherits camofox's CAMOFOX_SERVE_CMD implicitly: the camofox
    // provider is launched first in `prepare` and reads that env var itself.
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
  resolveLocalCmd: (opts) => resolveBureauCmd(opts.launchCmd, opts.env),
  async prepare(opts, ctx) {
    // Camofox must be up before bureau serve can start.
    const cam = await camofox.launch(
      {
        port: opts.camofoxPort ?? 9377,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      },
      ctx,
    )
    const camofoxUrl = cam.endpoints.rest ?? "http://127.0.0.1:9377"
    // PORT must reflect the resolved port.
    return (port) => ({ CAMOFOX_URL: camofoxUrl, PORT: String(port) })
  },
})

export const bureauAdapter: BrowserAdapterHandle = toAdapterHandle(bureauProvider, {
  defaultPort: 8830,
  healthPath: "/health",
})
