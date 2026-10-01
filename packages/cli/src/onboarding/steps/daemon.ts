/**
 * daemon — is the daemon answering `/health`, and (macOS) is it installed
 * as a launchd service with a fresh PATH. Reuses `commands/daemon.ts`'s
 * probes; never kickstarts, rewrites, or reloads anything.
 */

import {
  LAUNCHD_LABEL,
  SCHTASKS_TASK_NAME,
  computeFreshDaemonPath,
  extractPlistPathValue,
  fetchHealth,
  globalNodeModulesDir,
  humaniseUptime,
  launchdPlistPath,
  pathNeedsRefresh,
  type DaemonHealthInfo,
} from "../../commands/daemon.js"
import { catalogByType } from "../../registry/catalog.js"
import type { OnboardingStep, SetupAction, StepCheck, StepContext } from "../types.js"
import { readText, tildify } from "./_util.js"

const DEFAULT_PORT = 18790

interface HealthResult {
  check: StepCheck
  /** The `/health` body when reachable, else `null` — the node/adapter check
   *  needs the daemon's Node binary (`info.node`). */
  info: DaemonHealthInfo | null
}

async function checkHealth(ctx: StepContext, serviceInstalled: boolean): Promise<HealthResult> {
  const config = await ctx.sources.loadConfig()
  const port = config.daemon?.port ?? DEFAULT_PORT
  const info = await fetchHealth({ config, fetchImpl: ctx.fetch })
  const managedFix =
    ctx.platform === "win32"
      ? serviceInstalled
        ? "agentproto daemon start"
        : "agentproto daemon install"
      : null
  if (!info) {
    return {
      info: null,
      check: {
        id: "daemon.health",
        title: "Daemon /health",
        status: "missing",
        detail: `not reachable on port ${port}`,
        fix:
          ctx.platform === "darwin"
            ? serviceInstalled
              ? "agentproto daemon start"
              : "agentproto daemon install"
            : managedFix ?? "agentproto serve",
        data: { port, reachable: false },
      },
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
      info,
      check: {
        id: "daemon.health",
        title: "Daemon /health",
        status: "warn",
        detail: `${version}${up} at ${info.url}, but this CLI is v${ctx.cliVersion}`,
        fix: ctx.platform === "darwin" ? "agentproto daemon restart" : managedFix ?? "restart `agentproto serve`",
        data,
      },
    }
  }
  return {
    info,
    check: { id: "daemon.health", title: "Daemon /health", status: "ok", detail: `${version}${up} at ${info.url}`, data },
  }
}

/**
 * F4 — node/adapter mismatch. Global `@agentproto/adapter-*` packages resolve
 * relative to the CLI's own install (`registry/manifest-loader.ts`'s
 * `createRequire(import.meta.url)`), which lives under whichever Node
 * installed the CLI. After an nvm/fnm switch the daemon can be running a
 * DIFFERENT Node than the one the user just installed adapters under: that
 * Node's global install has no adapters, so `agent_start` fails
 * `adapter "<x>" could not be resolved` while the packages look installed.
 *
 * `/health` reports the daemon's Node (`info.node`); compare it against this
 * CLI's Node and, when the two differ, ask each Node's global install whether
 * it can see the catalog's adapters. Any adapter this CLI's Node resolves but
 * the daemon's does not is the mismatch — warn with the exact reinstall
 * command. Same Node (the common case), an older daemon without `node`, or no
 * divergence in what resolves ⇒ nothing to report (the `agents` step already
 * covers genuinely-uninstalled adapters).
 */
async function checkNodeAdapterMismatch(ctx: StepContext, info: DaemonHealthInfo): Promise<StepCheck | null> {
  const daemonNode = info.node
  if (!daemonNode) return null
  const cliNode = ctx.sources.nodeExecPath()
  if (globalNodeModulesDir(daemonNode, ctx.platform) === globalNodeModulesDir(cliNode, ctx.platform)) return null
  const missing = catalogByType("agent-cli").filter(
    (entry) =>
      ctx.sources.resolveAdapterPackage(entry.slug, cliNode) !== null &&
      ctx.sources.resolveAdapterPackage(entry.slug, daemonNode) === null,
  )
  if (missing.length === 0) return null
  const slugs = missing.map((entry) => entry.slug)
  const packages = missing.map((entry) => entry.packageName ?? `@agentproto/adapter-${entry.slug}`)
  return {
    id: "daemon.node-adapters",
    title: "Adapters / Node version",
    status: "warn",
    detail:
      `the daemon runs ${daemonNode}, but ${slugs.join(", ")} resolve only under this ` +
      `CLI's Node (${cliNode}) — the daemon can't see them`,
    fix: `npm i -g ${packages.join(" ")}`,
    data: { daemonNode, cliNode, missing: slugs },
  }
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

async function checkTask(
  ctx: StepContext,
  taskName: string,
): Promise<StepCheck> {
  const out = await ctx.exec("schtasks", ["/Query", "/TN", taskName], { timeoutMs: 3_000 })
  if (out.code !== 0) {
    return {
      id: "daemon.service",
      title: "Scheduled task",
      status: "warn",
      detail: "not registered (a foreground `agentproto serve` also works)",
      fix: "agentproto daemon install",
      data: { task: taskName, installed: false, running: false },
    }
  }
  const running = /^\s*Status:\s*Running/im.test(out.stdout)
  return {
    id: "daemon.service",
    title: "Scheduled task",
    status: "ok",
    detail: running ? "registered · running" : "registered",
    data: { task: taskName, installed: true, running },
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
    if (ctx.platform === "win32") {
      const task = await checkTask(ctx, SCHTASKS_TASK_NAME)
      const installed = task.status === "ok"
      const health = await checkHealth(ctx, installed)
      const checks = [health.check, task]
      if (health.info) {
        const mismatch = await checkNodeAdapterMismatch(ctx, health.info)
        if (mismatch) checks.push(mismatch)
      }
      return checks
    }
    if (ctx.platform !== "darwin") {
      const health = await checkHealth(ctx, false)
      const checks: StepCheck[] = [
        health.check,
        {
          id: "daemon.service",
          title: "Service manager",
          status: "warn",
          detail: `no service manager support on ${ctx.platform} yet, run \`agentproto serve\``,
          fix: "agentproto serve",
        },
      ]
      if (health.info) {
        const mismatch = await checkNodeAdapterMismatch(ctx, health.info)
        if (mismatch) checks.push(mismatch)
      }
      return checks
    }
    const plistPath = launchdPlistPath(ctx.homedir)
    const plistXml = await readText(ctx, plistPath)
    const health = await checkHealth(ctx, plistXml !== null)
    const checks = [health.check, await checkService(ctx, plistXml, plistPath)]
    if (plistXml !== null) checks.push(await checkPlistPath(ctx, plistXml))
    if (health.info) {
      const mismatch = await checkNodeAdapterMismatch(ctx, health.info)
      if (mismatch) checks.push(mismatch)
    }
    return checks
  },
  async plan(checks, ctx) {
    const health = checks.find((c) => c.id === "daemon.health")
    const service = checks.find((c) => c.id === "daemon.service")
    const path = checks.find((c) => c.id === "daemon.path")
    const actions: SetupAction[] = []
    if (ctx.platform === "win32") {
      if (service?.status === "warn" && service.fix === "agentproto daemon install") {
        actions.push({
          id: "daemon.install",
          title: "Install the daemon as a scheduled task at logon and start it",
          default: true,
          async apply(io) {
            const installed = await io.verbs.daemon(["install"])
            if (installed !== 0) return { ok: false, detail: `daemon install exited ${installed}` }
            const started = await io.verbs.daemon(["start"])
            return started === 0 ? { ok: true, detail: "installed and started" } : { ok: false, detail: `daemon start exited ${started}` }
          },
        })
      } else if (health?.status === "missing") {
        actions.push({
          id: "daemon.start",
          title: "Start the daemon",
          default: true,
          async apply(io) {
            const code = await io.verbs.daemon(["start"])
            return code === 0 ? { ok: true, detail: "started" } : { ok: false, detail: `daemon start exited ${code}` }
          },
        })
      }
      return actions
    }
    if (ctx.platform !== "darwin") {
      if (health?.status === "missing") {
        actions.push({
          id: "daemon.serve",
          title: "Start `agentproto serve` in the background (service support for this OS is coming)",
          default: true,
          async apply(io) {
            const port = await io.verbs.ensureDaemon()
            return port === null
              ? { ok: false, detail: "the daemon did not answer /health — run `agentproto serve` in a terminal" }
              : { ok: true, detail: `daemon up on port ${port}` }
          },
        })
      }
      return actions
    }
    if (service?.status === "warn" && service.fix === "agentproto daemon install") {
      actions.push({
        id: "daemon.install",
        title: "Install the daemon as a login service (launchd) and start it",
        default: true,
        async apply(io) {
          const installed = await io.verbs.daemon(["install"])
          if (installed !== 0) return { ok: false, detail: `daemon install exited ${installed}` }
          const started = await io.verbs.daemon(["start"])
          return started === 0 ? { ok: true, detail: "installed and started" } : { ok: false, detail: `daemon start exited ${started}` }
        },
      })
    } else if (health?.status === "missing") {
      actions.push({
        id: "daemon.start",
        title: "Start the daemon",
        default: true,
        async apply(io) {
          const code = await io.verbs.daemon(["start"])
          return code === 0 ? { ok: true, detail: "started" } : { ok: false, detail: `daemon start exited ${code}` }
        },
      })
    }
    const stale = [
      health?.status === "warn" ? "it runs a different version than this CLI" : null,
      path?.status === "warn" ? "its PATH is stale" : null,
    ].filter((r): r is string => r !== null)
    if (stale.length > 0 && actions.length === 0) {
      actions.push({
        id: "daemon.restart",
        title: `Restart the daemon (${stale.join(", ")}; running sessions are stopped)`,
        default: false,
        async apply(io) {
          const code = await io.verbs.daemon(["restart"])
          return code === 0 ? { ok: true, detail: "restarted" } : { ok: false, detail: `daemon restart exited ${code}` }
        },
      })
    }
    return actions
  },
}
