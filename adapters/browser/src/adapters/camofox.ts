import { platform } from "node:os"
import type { BrowserAdapterHandle, BrowserAdapterStartOptions, BrowserAdapterInstance } from "../types.js"
import { resolveLaunch } from "../lib/resolve-launch.js"

function resolveCmd(
  launchCmd: string | undefined,
  env: Record<string, string> | undefined
): { file: string; args: string[]; isLaunchctl?: boolean } | null {
  if (launchCmd) return { file: "/bin/sh", args: ["-c", launchCmd] }
  const envCmd = env?.CAMOFOX_SERVE_CMD ?? process.env.CAMOFOX_SERVE_CMD
  if (envCmd) return { file: "/bin/sh", args: ["-c", envCmd] }
  if (platform() === "darwin")
    return { file: "launchctl", args: ["start", "com.agentik.camofox"], isLaunchctl: true }
  return null
}

export const camofoxAdapter: BrowserAdapterHandle = {
  id: "camofox",
  name: "Camofox (stealth Firefox headless)",
  description:
    "Camofox headless stealth Firefox REST API on :9377. Exposes /sessions, /tabs, and /health. Required dependency for the bureau adapter.",
  defaultPort: 9377,
  healthPath: "/health",

  location: "local",

  install: [
    {
      method: "vendored",
      // Shipped via the agentik launchd plist on macOS; on other platforms
      // install camofox separately and point CAMOFOX_SERVE_CMD at it.
    },
  ],

  requires: {
    // nativeLaunchOs ≠ hard constraint: the adapter is available on all
    // platforms.  This field only signals that the built-in launchd path
    // (com.agentik.camofox) exists on macOS; elsewhere CAMOFOX_SERVE_CMD
    // or opts.launchCmd must be provided.
    nativeLaunchOs: ["darwin"],
  },

  config: [
    {
      id: "camofox-serve-cmd",
      kind: "prompt",
      prompt: "Shell command to start camofox (leave blank on macOS when using the com.agentik.camofox launchd plist)",
      description:
        "Required on non-macOS hosts.  On macOS this overrides the default `launchctl start com.agentik.camofox` path.",
      type: "text",
      persist: { env: "CAMOFOX_SERVE_CMD" },
    },
  ],

  async ensure(opts: BrowserAdapterStartOptions): Promise<BrowserAdapterInstance> {
    return resolveLaunch({
      handle: this,
      opts,
      label: "camofox",
      resolveLocalCmd: () => resolveCmd(opts.launchCmd, opts.env),
    })
  },
}
