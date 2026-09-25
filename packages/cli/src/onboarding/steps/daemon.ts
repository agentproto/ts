/**
 * daemon — is the daemon answering `/health`, and (macOS) is it installed
 * as a launchd service with a fresh PATH. Reuses `commands/daemon.ts`'s
 * probes; never kickstarts, rewrites, or reloads anything.
 */

import {
  LAUNCHD_LABEL,
  computeFreshDaemonPath,
  extractPlistPathValue,
  fetchHealth,
  humaniseUptime,
  launchdPlistPath,
  pathNeedsRefresh,
} from "../../commands/daemon.js"
import type { OnboardingStep, StepCheck, StepContext } from "../types.js"
import { readText, tildify } from "./_util.js"

const DEFAULT_PORT = 18790

async function checkHealth(ctx: StepContext, serviceInstalled: boolean): Promise<StepCheck> {
  const config = await ctx.sources.loadConfig()
  const port = config.daemon?.port ?? DEFAULT_PORT
  const info = await fetchHealth({ config, fetchImpl: ctx.fetch })
  if (!info) {
    return {
      id: "daemon.health",
      title: "Daemon /health",
      status: "missing",
      detail: `not reachable on port ${port}`,
      fix:
        ctx.platform === "darwin"
          ? serviceInstalled
            ? "agentproto daemon start"
            : "agentproto daemon install"
          : "agentproto serve",
      data: { port, reachable: false },
    }
  }
  const data = {
    port,
    reachable: true,
    url: info.url,
    version: info.version ?? null,
    uptimeMs: info.uptimeMs ?? null,
    pid: info.pid ?? null,
  }
  const up = info.uptimeMs !== undefined ? `, up ${humaniseUptime(info.uptimeMs)}` : ""
  const version = info.version ? `v${info.version}` : "unknown version"
  if (info.version && info.version !== ctx.cliVersion) {
    return {
      id: "daemon.health",
      title: "Daemon /health",
      status: "warn",
      detail: `${version}${up} at ${info.url}, but this CLI is v${ctx.cliVersion}`,
      fix: ctx.platform === "darwin" ? "agentproto daemon restart" : "restart `agentproto serve`",
      data,
    }
  }
  return { id: "daemon.health", title: "Daemon /health", status: "ok", detail: `${version}${up} at ${info.url}`, data }
}

async function checkService(
  ctx: StepContext,
  plistXml: string | null,
  plistPath: string,
): Promise<StepCheck> {
  if (plistXml === null) {
    return {
      id: "daemon.service",
      title: "launchd service",
      status: "warn",
      detail: "not installed (a foreground `agentproto serve` also works)",
      fix: "agentproto daemon install",
      data: { plist: plistPath, installed: false, loaded: false },
    }
  }
  const out = await ctx.exec("launchctl", ["print", `gui/${ctx.uid ?? 0}/${LAUNCHD_LABEL}`], { timeoutMs: 3_000 })
  const loaded = out.code === 0
  const pid = out.stdout.match(/^\s*pid\s*=\s*(\d+)/m)?.[1]
  const data = { plist: plistPath, installed: true, loaded, pid: pid ? Number(pid) : null }
  return loaded
    ? { id: "daemon.service", title: "launchd service", status: "ok", detail: `loaded${pid ? ` (pid ${pid})` : ""}`, data }
    : {
        id: "daemon.service",
        title: "launchd service",
        status: "warn",
        detail: `${tildify(ctx, plistPath)} exists but is not loaded`,
        fix: "agentproto daemon install",
        data,
      }
}

async function checkPlistPath(ctx: StepContext, plistXml: string): Promise<StepCheck> {
  const current = extractPlistPathValue(plistXml)
  const probed = await ctx.sources.loginShellPath().catch(() => null)
  if (probed === null) {
    return {
      id: "daemon.path",
      title: "Service PATH",
      status: "warn",
      detail: "not checked: could not probe the login-shell PATH",
    }
  }
  const fresh = await computeFreshDaemonPath(async () => probed)
  return pathNeedsRefresh(current, fresh)
    ? {
        id: "daemon.path",
        title: "Service PATH",
        status: "warn",
        detail: "the daemon's PATH is older than your shell's (CLIs installed since may be invisible to it)",
        fix: "agentproto daemon restart",
      }
    : { id: "daemon.path", title: "Service PATH", status: "ok", detail: "matches your login shell" }
}

export const daemonStep: OnboardingStep = {
  id: "daemon",
  title: "Daemon",
  required: true,
  async detect(ctx) {
    if (ctx.platform !== "darwin") {
      return [
        await checkHealth(ctx, false),
        {
          id: "daemon.service",
          title: "Service manager",
          status: "warn",
          detail: `no service manager support on ${ctx.platform} yet, run \`agentproto serve\``,
          fix: "agentproto serve",
        },
      ]
    }
    const plistPath = launchdPlistPath(ctx.homedir)
    const plistXml = await readText(ctx, plistPath)
    const checks = [await checkHealth(ctx, plistXml !== null), await checkService(ctx, plistXml, plistPath)]
    if (plistXml !== null) checks.push(await checkPlistPath(ctx, plistXml))
    return checks
  },
}
