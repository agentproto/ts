import { spawn as nodeSpawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { homedir, platform as osPlatform } from "node:os"
import { join } from "node:path"

export const DEFAULT_CAMOFOX_PORT = 9377
export const DEFAULT_LAUNCHD_LABEL = "com.agentik.camofox"

export interface LaunchCommand {
  file: string
  args: string[]
  /** launchctl exits at once; the managed process is not our child, so there is no pid. */
  isLaunchctl?: boolean
}

export interface SpawnedProcess {
  pid?: number
  unref(): void
}

export interface SpawnOptions {
  env: Record<string, string | undefined>
}

export type SpawnFn = (file: string, args: string[], options: SpawnOptions) => SpawnedProcess

export const defaultSpawn: SpawnFn = (file, args, options) => {
  const child = nodeSpawn(file, args, { detached: true, stdio: "ignore", env: options.env })
  child.unref()
  return child
}

/**
 * Best-effort read of the env values `agentproto browser install` persisted:
 * `$AGENTPROTO_HOME/browser-adapters/<id>.json`. `{}` on any failure.
 */
export async function readPersistedEnv(adapterId: string): Promise<Record<string, string>> {
  const base = process.env["AGENTPROTO_HOME"] ?? join(homedir(), ".agentproto")
  try {
    const raw = await readFile(join(base, "browser-adapters", `${adapterId}.json`), "utf8")
    const parsed = JSON.parse(raw) as { envValues?: Record<string, string> }
    return parsed.envValues ?? {}
  } catch {
    return {}
  }
}

export interface ResolveCommandInput {
  launchCmd?: string
  env: Record<string, string | undefined>
  launchdLabel: string
  platform: string
}

/** `launchCmd`, then `CAMOFOX_SERVE_CMD`, then launchd on macOS, else nothing. */
export function resolveCamofoxLaunchCommand(input: ResolveCommandInput): LaunchCommand | null {
  if (input.launchCmd) return { file: "/bin/sh", args: ["-c", input.launchCmd] }
  const envCmd = input.env["CAMOFOX_SERVE_CMD"]
  if (envCmd) return { file: "/bin/sh", args: ["-c", envCmd] }
  if (input.platform === "darwin") {
    return { file: "launchctl", args: ["start", input.launchdLabel], isLaunchctl: true }
  }
  return null
}

export function currentPlatform(): string {
  return osPlatform()
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]"
}

/** SIGTERM the process group we started (it is its own group leader), else the pid. */
export function terminate(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM")
    return
  } catch {
    // group already gone: fall through to the direct pid
  }
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    // already exited
  }
}
