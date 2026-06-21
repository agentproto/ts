import type { BrowserAdapterHandle, BrowserAdapterStartOptions, BrowserAdapterInstance } from "../types.js"
import { resolveLaunch } from "../lib/resolve-launch.js"

export function resolveCmd(
  launchCmd: string | undefined,
  env: Record<string, string> | undefined,
  log: ((s: string) => void) | undefined
): { file: string; args: string[]; cwd?: string } {
  if (launchCmd) return { file: "/bin/sh", args: ["-c", launchCmd] }
  const envCmd = env?.CHROMIUM_SERVE_CMD ?? process.env.CHROMIUM_SERVE_CMD
  if (envCmd) return { file: "/bin/sh", args: ["-c", envCmd] }

  // Default pnpm filter command — requires the workspace root as cwd.
  const cwd = resolveCwd(env, log)
  return { file: "/bin/sh", args: ["-c", "pnpm --filter=@agstudio/browser-service start"], cwd }
}

/**
 * Resolve the working directory for the spawned browser-service process.
 *
 * Priority: CHROMIUM_SERVE_CWD from caller env > same var from process env >
 * undefined (spawn inherits the daemon's own cwd, which is the pnpm workspace
 * root when the daemon was started normally). When the default pnpm --filter
 * command is used and no cwd is resolvable, a warning is emitted — pnpm needs
 * the workspace root to match the filter.
 */
function resolveCwd(
  env: Record<string, string> | undefined,
  log: ((s: string) => void) | undefined
): string | undefined {
  const explicit = env?.CHROMIUM_SERVE_CWD ?? process.env.CHROMIUM_SERVE_CWD
  if (explicit) return explicit
  log?.(
    "[chromium] warning: CHROMIUM_SERVE_CWD is not set; relying on daemon cwd for " +
      "`pnpm --filter=@agstudio/browser-service start`. Set CHROMIUM_SERVE_CWD or run the daemon " +
      "from the repo root, or override with CHROMIUM_SERVE_CMD."
  )
  return undefined
}

export const chromiumAdapter: BrowserAdapterHandle = {
  id: "chromium",
  name: "Chromium Browser Service",
  description:
    "Heavy Chromium webservice (projects/browser/apps/service) on :3200. Exposes /healthz, /readyz, REST session routes, and a CDP WebSocket proxy.",
  defaultPort: 3200,
  healthPath: "/healthz",

  location: "local",

  install: [
    {
      method: "path",
      // Local: `pnpm --filter=@agstudio/browser-service start` from the monorepo root,
      // or set CHROMIUM_SERVE_CMD / CHROMIUM_SERVE_CWD to point at a custom launcher.
      // Cloud variant (future — not yet wired into ensure):
      //   method: "cloud", url: process.env.BROWSER_SERVICE_URL, secret: "BROWSER_SERVICE_KEY"
    },
  ],

  config: [
    {
      id: "chromium-serve-cmd",
      kind: "prompt",
      prompt: "Shell command to start the browser service (default: pnpm --filter=@agstudio/browser-service start)",
      description:
        "Override CHROMIUM_SERVE_CMD.  When blank, the default pnpm filter command is used and " +
        "CHROMIUM_SERVE_CWD must point to the monorepo root.",
      type: "text",
      persist: { env: "CHROMIUM_SERVE_CMD" },
    },
    {
      id: "chromium-serve-cwd",
      kind: "prompt",
      prompt: "Working directory for the browser service (monorepo root required for the pnpm filter command)",
      type: "text",
      persist: { env: "CHROMIUM_SERVE_CWD" },
    },
    // Future cloud step (T9+):
    // { id: "chromium-cloud-url",   kind: "prompt", prompt: "Remote browser-service URL", type: "text",   persist: { env: "BROWSER_SERVICE_URL" } },
    // { id: "chromium-cloud-token", kind: "prompt", prompt: "X-Internal-Key token",        type: "secret", persist: { env: "BROWSER_SERVICE_KEY" } },
  ],

  async ensure(opts: BrowserAdapterStartOptions): Promise<BrowserAdapterInstance> {
    return resolveLaunch({
      handle: this,
      opts,
      label: "chromium",
      resolveLocalCmd: () => resolveCmd(opts.launchCmd, opts.env, opts.log),
      // Kill the whole process group so the pnpm-forked node child is not orphaned.
      killProcessGroup: true,
    })
  },
}
