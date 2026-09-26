/**
 * The real {@link StepContext}: host primitives plus the existing CLI/runtime
 * helpers each step reuses. Everything wired here is read-only.
 */

import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import { arch, homedir, platform } from "node:os"
import { loadConfig } from "@agentproto/runtime/config"
import { loadWorkspacesConfig } from "@agentproto/runtime/workspaces-config"
import { fetchLatestCliVersion } from "@agentproto/runtime/release-check"
import { discoverCredentials } from "@agentproto/runtime/credential-discovery"
import { listAuthProfiles } from "@agentproto/auth"
import { probeLoginShellPath } from "../commands/daemon.js"
import { detectAgents, loadInstallState } from "../commands/install-mcp.js"
import { resolveSkillFanOutTargets } from "../commands/install-skill.js"
import { resolveSkillPackDir } from "../commands/skill-install/pack-resolve.js"
import { resolveAdapter } from "../registry/resolve.js"
import { npmLatestVersion } from "../registry/freshness.js"
import type { ExecFn, StepContext, StepFs } from "./types.js"

const NETWORK_TIMEOUT_MS = 3_000

export const realFs: StepFs = {
  readFile: (path) => fs.readFile(path, "utf8"),
  access: (path, mode) => fs.access(path, mode),
  stat: (path) => fs.stat(path),
  readdir: (path) => fs.readdir(path),
}

/** Spawn a probe, capture its output; resolves `124` on timeout, `127` on
 *  spawn failure — never rejects. */
export const realExec: ExecFn = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    const done = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    }
    const child = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"] })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      done(124)
    }, opts.timeoutMs ?? 5_000)
    child.stdout?.setEncoding("utf8").on("data", (c: string) => (stdout += c))
    child.stderr?.setEncoding("utf8").on("data", (c: string) => (stderr += c))
    child.once("error", (err) => {
      stderr += err.message
      done(127)
    })
    child.once("exit", (code) => done(code ?? 1))
  })

export function createStepContext(cliVersion: string): StepContext {
  return {
    fs: realFs,
    exec: realExec,
    fetch: (input, init) => fetch(input, init),
    env: process.env,
    homedir: homedir(),
    cwd: process.cwd(),
    platform: platform(),
    arch: arch(),
    nodeVersion: process.version,
    uid: process.getuid?.() ?? null,
    cliVersion,
    now: () => Date.now(),
    sources: {
      loadConfig: () => loadConfig(),
      loadWorkspaces: () => loadWorkspacesConfig(),
      latestCliVersion: () => fetchLatestCliVersion({ timeoutMs: NETWORK_TIMEOUT_MS }),
      loginShellPath: () => probeLoginShellPath(),
      resolveAdapterHandle: async (slug) => (await resolveAdapter(slug)).handle,
      listAuthProfiles: () => listAuthProfiles(),
      discoverCredentials: async () => discoverCredentials(),
      detectClients: () => detectAgents(),
      loadMcpInstallState: () => loadInstallState(),
      skillTargets: async () => (await resolveSkillFanOutTargets()).targets,
      resolveSkillPackDir: () => resolveSkillPackDir(undefined, { allowFetch: false }),
      latestSkillPackVersion: () => npmLatestVersion("@agentproto/skill-pack-agentproto", NETWORK_TIMEOUT_MS),
    },
  }
}
