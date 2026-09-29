import { chromium, type ChromiumLaunchOptions, type ChromiumProvider } from "@agentproto/adapter-browser-chromium"
import { toAdapterHandle } from "../providers/to-adapter-handle.js"
import type { BrowserAdapterHandle, BrowserAdapterInstance, BrowserAdapterStartOptions } from "../types.js"

/**
 * Legacy launch-command resolution, kept exported for its pinned tests. The
 * facade no longer uses it: `chromium` is now the real Playwright provider
 * (`@agentproto/adapter-browser-chromium`), not a service-process handle.
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

/** The kit `chromium` provider: Playwright Chromium on its own dedicated profile dir (never the user's Chrome profile). */
export const chromiumProvider: ChromiumProvider = chromium

const CHROMIUM_META = {
  defaultPort: 3200,
  healthPath: "/healthz",
  name: "Chromium (Playwright)",
  description:
    "Chromium driven by Playwright on its own dedicated profile dir, with CDP access. Install the binary with `npx playwright install chromium`.",
} as const

async function ensureChromium(opts: BrowserAdapterStartOptions): Promise<BrowserAdapterInstance> {
  if (opts.location === "cloud") {
    throw new Error("[chromium] the chromium provider runs locally; use a remote browser provider for location=cloud")
  }
  const executablePath = opts.binPath ?? opts.env?.CHROMIUM_EXECUTABLE_PATH
  const launchOpts: ChromiumLaunchOptions = {
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(executablePath !== undefined ? { executablePath } : {}),
  }
  const instance = await chromiumProvider.launch(launchOpts, opts.log ? { log: opts.log } : {})
  const cdp = instance.endpoints.cdp
  if (!cdp) throw new Error("[chromium] the provider returned no CDP endpoint")
  const url = new URL(cdp)
  const port = Number(url.port)
  return {
    id: chromiumProvider.id,
    port,
    baseUrl: `http://${url.host}`,
    wasAlreadyRunning: instance.wasAlreadyRunning,
    healthy: (await instance.health()).ok,
    stop: () => instance.stop(),
  }
}

export const chromiumAdapter: BrowserAdapterHandle = {
  ...toAdapterHandle(chromiumProvider, CHROMIUM_META),
  ensure: ensureChromium,
}
