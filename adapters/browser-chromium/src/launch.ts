import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { BrowserContext, BrowserType, LaunchOptions } from "playwright-core"

export interface PlaywrightChromium {
  launchPersistentContext(userDataDir: string, options?: Parameters<BrowserType["launchPersistentContext"]>[1]): Promise<BrowserContext>
  executablePath(): string
}

export type PlaywrightLoader = () => Promise<{ chromium: PlaywrightChromium }>

export const INSTALL_HINT = "npx playwright install chromium"

/** `playwright-core` is an optional peer: import it lazily so this package loads without it. */
export const loadPlaywright: PlaywrightLoader = async () => {
  try {
    const mod = (await import("playwright-core")) as { chromium: PlaywrightChromium }
    return { chromium: mod.chromium }
  } catch (err) {
    throw new Error(`[chromium] playwright-core is not installed (add it as a dependency): ${err instanceof Error ? err.message : String(err)}`)
  }
}

export type PlaywrightLaunchOptions = LaunchOptions

/** Root of the dedicated profile dirs: `$AGENTPROTO_HOME/browser/chromium`, default `~/.agentproto/browser/chromium`. */
export function defaultDataDir(env: Record<string, string | undefined> = process.env): string {
  return join(env["AGENTPROTO_HOME"] ?? join(homedir(), ".agentproto"), "browser", "chromium")
}

export interface DevToolsEndpoint {
  port: number
  browserWsPath: string
}

/** Parse Chromium's `DevToolsActivePort` file: line 1 the port, line 2 the browser ws path. */
export function parseDevToolsActivePort(text: string): DevToolsEndpoint | undefined {
  const [portLine, pathLine] = text.split("\n").map((l) => l.trim())
  const port = Number(portLine)
  if (!Number.isInteger(port) || port <= 0 || !pathLine) return undefined
  return { port, browserWsPath: pathLine }
}

/** Wait until Chromium has written `DevToolsActivePort` in `dir`; the file is stale-proof because the dir is ours and fresh per launch. */
export async function readDevToolsEndpoint(dir: string, timeoutMs: number, sleep: (ms: number) => Promise<void>): Promise<DevToolsEndpoint> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const parsed = parseDevToolsActivePort(await readFile(join(dir, "DevToolsActivePort"), "utf8"))
      if (parsed) return parsed
    } catch {
      // not written yet
    }
    if (Date.now() >= deadline) throw new Error(`[chromium] DevToolsActivePort did not appear in ${dir} within ${Math.round(timeoutMs / 1000)}s`)
    await sleep(50)
  }
}
