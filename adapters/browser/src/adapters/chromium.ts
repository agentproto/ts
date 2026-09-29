import { createProcessProvider } from "../providers/process-provider.js"
import { toAdapterHandle } from "../providers/to-adapter-handle.js"
import type { BrowserAdapterHandle } from "../types.js"

/**
 * Legacy launch-command resolution, kept exported for its pinned tests. The
 * facade no longer uses it: it defaulted to a private `pnpm --filter` command
 * that only exists inside one monorepo. See {@link resolveChromiumLaunch}.
 */
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

function resolveCwd(
  env: Record<string, string> | undefined,
  log: ((s: string) => void) | undefined
): string | undefined {
  const explicit = env?.CHROMIUM_SERVE_CWD ?? process.env.CHROMIUM_SERVE_CWD
  if (explicit) return explicit
  log?.(
    "[chromium] warning: CHROMIUM_SERVE_CWD is not set; relying on daemon cwd for " +
      "the default pnpm filter command. Set CHROMIUM_SERVE_CWD or run the daemon " +
      "from the repo root, or override with CHROMIUM_SERVE_CMD."
  )
  return undefined
}

/** Facade launch resolution: `launchCmd`, then `CHROMIUM_SERVE_CMD`, else no command (never a private default). */
export function resolveChromiumLaunch(
  launchCmd: string | undefined,
  env: Record<string, string> | undefined
): { file: string; args: string[]; cwd?: string } | null {
  const cmd = launchCmd ?? env?.CHROMIUM_SERVE_CMD ?? process.env.CHROMIUM_SERVE_CMD
  if (!cmd) return null
  const cwd = env?.CHROMIUM_SERVE_CWD ?? process.env.CHROMIUM_SERVE_CWD
  return { file: "/bin/sh", args: ["-c", cmd], ...(cwd ? { cwd } : {}) }
}

export const chromiumProvider = createProcessProvider({
  id: "chromium",
  name: "Chromium Browser Service",
  description:
    "Chromium webservice on :3200. Exposes /healthz, /readyz, REST session routes, and a CDP WebSocket proxy.",
  defaultPort: 3200,
  healthPath: "/healthz",
  install: [{ method: "path" }],
  config: [
    {
      id: "chromium-serve-cmd",
      kind: "prompt",
      prompt: "Shell command to start the browser service",
      description: "Sets CHROMIUM_SERVE_CMD. Required: there is no built-in default launch command.",
      type: "text",
      persist: { env: "CHROMIUM_SERVE_CMD" },
    },
    {
      id: "chromium-serve-cwd",
      kind: "prompt",
      prompt: "Working directory for the browser service (optional)",
      type: "text",
      persist: { env: "CHROMIUM_SERVE_CWD" },
    },
  ],
  resolveLocalCmd: (opts) => resolveChromiumLaunch(opts.launchCmd, opts.env),
  // Kill the whole process group so a shell-forked child is not orphaned.
  killProcessGroup: true,
})

export const chromiumAdapter: BrowserAdapterHandle = toAdapterHandle(chromiumProvider, {
  defaultPort: 3200,
  healthPath: "/healthz",
  name: "Chromium Browser Service",
  description:
    "Heavy Chromium webservice (projects/browser/apps/service) on :3200. Exposes /healthz, /readyz, REST session routes, and a CDP WebSocket proxy.",
})
