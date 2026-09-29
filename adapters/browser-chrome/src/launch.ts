import { spawn as nodeSpawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/** The slice of a child process the provider uses; tests pass a stub. */
export interface ChromeProcess {
  pid?: number | undefined
  kill(signal?: NodeJS.Signals): boolean
  once(event: "exit", listener: () => void): unknown
}

export type SpawnChrome = (file: string, args: string[], options: { env: Record<string, string | undefined> }) => ChromeProcess

export const defaultSpawn: SpawnChrome = (file, args, options) => nodeSpawn(file, args, { stdio: "ignore", env: options.env })

/** Root of the dedicated profile dirs: `$AGENTPROTO_HOME/browser/chrome`, default `~/.agentproto/browser/chrome`. */
export function defaultDataDir(env: Record<string, string | undefined> = process.env): string {
  return join(env["AGENTPROTO_HOME"] ?? join(homedir(), ".agentproto"), "browser", "chrome")
}

export interface DevToolsEndpoint {
  port: number
  browserWsPath: string
}

/** Parse Chrome's `DevToolsActivePort` file: line 1 the port, line 2 the browser ws path. */
export function parseDevToolsActivePort(text: string): DevToolsEndpoint | undefined {
  const [portLine, pathLine] = text.split("\n").map((l) => l.trim())
  const port = Number(portLine)
  if (!Number.isInteger(port) || port <= 0 || !pathLine) return undefined
  return { port, browserWsPath: pathLine }
}

/** Wait for `DevToolsActivePort` in `dir` (the caller deleted any stale one first), or give up when the process exits. */
export async function readDevToolsEndpoint(
  dir: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  hasExited: () => boolean,
): Promise<DevToolsEndpoint> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const parsed = parseDevToolsActivePort(await readFile(join(dir, "DevToolsActivePort"), "utf8"))
      if (parsed) return parsed
    } catch {
      // not written yet
    }
    if (hasExited()) throw new Error(`[chrome] the browser exited before it opened a DevTools port (profile dir ${dir})`)
    if (Date.now() >= deadline) throw new Error(`[chrome] DevToolsActivePort did not appear in ${dir} within ${Math.round(timeoutMs / 1000)}s`)
    await sleep(50)
  }
}

export interface BuildArgsInput {
  dir: string
  port: number
  headless: boolean
  extraArgs: readonly string[]
}

/** The argv for a launch. The dedicated dir and the debugging port come only from here. */
export function buildChromeArgs(input: BuildArgsInput): string[] {
  return [
    `--user-data-dir=${input.dir}`,
    `--remote-debugging-port=${input.port}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(input.headless ? ["--headless=new"] : []),
    ...input.extraArgs,
    "about:blank",
  ]
}
