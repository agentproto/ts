/**
 * `agent_start({ browser: "headless" })` — an isolated headless Chrome for
 * one spawned agent, mounted as a per-session stdio MCP server
 * (`chrome-devtools-mcp --headless --isolated`, see
 * `@agentproto/plugin-local-browser`'s `buildHeadlessBrowserMcpEntry`).
 *
 * The server is a child of the adapter process, so it inherits the session's
 * `commandSandbox` confinement and normally dies with the adapter (stdin EOF,
 * and Chrome exits when its pipe closes). On `session:exited`,
 * `sweepSessionBrowser` does two things:
 *   - kills anything still carrying the session's `--agentproto-session=<id>`
 *     Chrome marker, in case an adapter never exited or never closed its MCP
 *     children;
 *   - deletes the session's profile dir, `$TMPDIR/agentproto-browser/<id>`.
 * The profile is caller-owned rather than `--isolated`, because `--isolated`
 * only cleans up on a graceful `browser.close()`; observed live, a killed
 * session left its puppeteer temp profile behind.
 */

import { execFile } from "node:child_process"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AcpMcpServer } from "@agentproto/acp"
import { loadAdapterSpawnSandboxConfig, type SandboxMode } from "@agentproto/command-sandbox"
import {
  buildHeadlessBrowserMcpEntry,
  ensureChromeDevtoolsMcp,
  headlessBrowserReadPaths,
  resolveChrome,
} from "@agentproto/plugin-local-browser"

/** `agent_start.browser`. `false` (the default) mounts nothing. */
export type SpawnBrowserMode = "headless" | false

/** Parse a loosely-typed `browser` value (HTTP body, ROLE.md, config). */
export function parseBrowserMode(raw: unknown): SpawnBrowserMode | undefined {
  if (raw === "headless") return "headless"
  if (raw === false || raw === "false" || raw === "off" || raw === "none") return false
  return undefined
}

/**
 * Precedence mirrors `deferredTools`: explicit spawn field > role default >
 * user preset > daemon `defaults.spawn.browser` > off.
 */
export function resolveBrowserMode(layers: {
  explicit?: SpawnBrowserMode | undefined
  role?: SpawnBrowserMode | undefined
  preset?: SpawnBrowserMode | undefined
  defaults?: SpawnBrowserMode | undefined
}): SpawnBrowserMode {
  return layers.explicit ?? layers.role ?? layers.preset ?? layers.defaults ?? false
}

/** Appended to the child's role context when the browser is mounted. */
export const HEADLESS_BROWSER_PROMPT_HINT =
  "You have your own headless Chrome (1440x900) through the `browser` MCP server " +
  "(in Claude Code: `mcp__browser__*`). Use navigate_page (http(s):// or file:// " +
  "URLs; workspace files work as file://<absolute path>), resize_page / emulate, " +
  "take_screenshot (inline, or `filePath` to save a PNG), evaluate_script, click / " +
  "fill, and list_console_messages for console errors and exceptions. Do not " +
  "launch Chrome yourself or hand-roll CDP. The browser is private to this " +
  "session and closes with it."

export interface HeadlessBrowserMount {
  entry: AcpMcpServer
  /** Read grants the adapter's `commandSandbox` needs for the MCP server +
   *  Chrome (threaded as `additionalReadPaths`). */
  readPaths: string[]
}

export interface ResolveHeadlessBrowserInput {
  sessionId: string
  cwd: string
  /** The spawn's explicit `commandSandbox`; `undefined` falls back to the
   *  workspace's `adapterSpawn` config, like the driver does. */
  commandSandbox?: SandboxMode
}

export type ResolveHeadlessBrowser = (
  input: ResolveHeadlessBrowserInput,
) => Promise<HeadlessBrowserMount>

/** The session's Chrome profile dir, deleted by `sweepSessionBrowser`. */
export function browserProfileDir(sessionId: string, root: string = tmpdir()): string {
  return join(root, "agentproto-browser", sessionId)
}

/** Chrome argv marker tying a launch to its session (sweep backstop). */
export function browserSessionMarker(sessionId: string): string {
  return `--agentproto-session=${sessionId}`
}

/**
 * Resolve chrome-devtools-mcp (installing it on first use) and a Chrome, and
 * build the session's mount. Under an OS sandbox Chrome runs with
 * `--no-sandbox` (Seatbelt refuses a nested `sandbox_init`); without
 * network (`strict`) only chrome-headless-shell starts, so system Chrome is
 * skipped rather than the sandbox widened — both validated in
 * plugin-local-browser's README.
 */
export const resolveHeadlessBrowser: ResolveHeadlessBrowser = async input => {
  const cfg = await loadAdapterSpawnSandboxConfig(input.cwd)
  const mode = input.commandSandbox ?? cfg.mode
  const confined = mode === "workspace" || mode === "strict"
  const noNetwork = confined && (mode === "strict" || cfg.network === "deny")
  const mcp = await ensureChromeDevtoolsMcp()
  const chrome = await resolveChrome(noNetwork ? { sources: ["env", "headless-shell"] } : {})
  const entry = buildHeadlessBrowserMcpEntry({
    mcp,
    executablePath: chrome.path,
    chromeSandbox: !confined,
    chromeArgs: [browserSessionMarker(input.sessionId)],
    userDataDir: browserProfileDir(input.sessionId),
    // Screenshot/file writes anywhere the agent itself may write: the real
    // boundary is the adapter tree's `commandSandbox`, and `cwd` here is the
    // pre-worktree base (a worktree spawn lands elsewhere).
    filesystemRoots: ["/"],
  })
  return { entry, readPaths: headlessBrowserReadPaths(mcp, chrome) }
}

// ── Exit sweep ────────────────────────────────────────────────────────

const trackedSessions = new Set<string>()

/** Record that `sessionId` was spawned with a headless browser. */
export function trackBrowserSession(sessionId: string): void {
  trackedSessions.add(sessionId)
}

export interface SweepDeps {
  /** `pid command` lines for every process (`ps -axo pid=,command=`). */
  listProcesses?: () => Promise<Array<{ pid: number; command: string }>>
  kill?: (pid: number, signal: NodeJS.Signals) => void
  removeDir?: (dir: string) => Promise<void>
  /** Root of the per-session profile dirs. Default `os.tmpdir()`. */
  profileRoot?: string
  /** Wait before signalling, so a clean shutdown gets to finish first. */
  graceMs?: number
}

/**
 * Kill anything still carrying this session's browser marker (the
 * chrome-devtools-mcp server and its Chrome), then delete the session's
 * profile dir. No-op for a session that never had a browser. Returns the
 * pids signalled.
 */
export async function sweepSessionBrowser(sessionId: string, deps: SweepDeps = {}): Promise<number[]> {
  if (!trackedSessions.delete(sessionId)) return []
  const graceMs = deps.graceMs ?? 3000
  if (graceMs > 0) await new Promise(r => setTimeout(r, graceMs))
  const list = deps.listProcesses ?? listProcesses
  const kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig))
  const removeDir = deps.removeDir ?? (dir => rm(dir, { recursive: true, force: true }))
  const marker = browserSessionMarker(sessionId)
  const survivors = (await list()).filter(p => p.pid !== process.pid && hasMarker(p.command, marker))
  const signalled: number[] = []
  for (const p of survivors) {
    try {
      kill(p.pid, "SIGKILL")
      signalled.push(p.pid)
    } catch {
      // already gone
    }
  }
  // Give SIGKILLed Chromes a moment to release the profile before deleting it.
  if (signalled.length > 0 && graceMs > 0) await new Promise(r => setTimeout(r, 500))
  await removeDir(browserProfileDir(sessionId, deps.profileRoot)).catch(() => {})
  return signalled
}

/** Exact-token match, so session `s1` never matches `s10`'s marker. */
function hasMarker(command: string, marker: string): boolean {
  let i = command.indexOf(marker)
  while (i >= 0) {
    const next = command[i + marker.length]
    if (next === undefined || next === " ") return true
    i = command.indexOf(marker, i + 1)
  }
  return false
}

function listProcesses(): Promise<Array<{ pid: number; command: string }>> {
  return new Promise(resolve => {
    execFile("ps", ["-axo", "pid=,command="], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([])
      const out: Array<{ pid: number; command: string }> = []
      for (const line of stdout.split("\n")) {
        const m = line.match(/^\s*(\d+)\s+(.*)$/)
        if (m) out.push({ pid: Number(m[1]), command: m[2] ?? "" })
      }
      resolve(out)
    })
  })
}
