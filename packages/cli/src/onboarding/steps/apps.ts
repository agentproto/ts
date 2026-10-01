/**
 * apps — are the built-in agentproto apps (ops-panel, …) installed? These
 * ship inside the CLI npm package under `node_modules/@agentproto/apps/` and
 * are registered into `~/.agentproto/apps.json` on demand.
 */

import type { OnboardingStep, StepCheck, StepContext } from "../types.js"

const BUILTIN_APPS = [
  {
    appId: "@agentproto/ops-panel",
    name: "Ops Panel",
    description: "Daemon ops cockpit — watchdog & manager sessions, workspace-filtered session list, GC and cron housekeeping.",
  },
]

export const appsStep: OnboardingStep = {
  id: "apps",
  title: "Apps",
  required: false,
  async detect(ctx) {
    const checks: StepCheck[] = []
    for (const app of BUILTIN_APPS) {
      const dir = await ctx.sources.resolveBuiltinAppDir(app.appId).catch(() => null)
      if (!dir) {
        checks.push({
          id: `apps.${app.appId}`,
          title: app.name,
          status: "skipped",
          detail: "not bundled in this CLI build",
        })
        continue
      }
      const installed = ctx.sources.appInstalled(app.appId)
      checks.push({
        id: `apps.${app.appId}`,
        title: app.name,
        status: installed ? "ok" : "warn",
        detail: installed ? "installed" : "not installed",
        fix: installed ? undefined : `agentproto app install ${dir}`,
        data: { dir, installed },
      })
    }
    return checks
  },
  async plan(checks, ctx) {
    const needed = checks.filter((c) => c.status === "warn")
    if (needed.length === 0) return []
    return needed.map((c) => ({
      id: `apps.install.${c.id}`,
      title: `Install ${c.title}`,
      default: true,
      async apply(io) {
        const dir = c.data?.dir
        if (typeof dir !== "string") {
          return { ok: false, detail: "could not resolve app source dir" }
        }
        const code = await io.verbs.appInstall(dir)
        if (code !== 0) return { ok: false, detail: `app install exited ${code}` }
        return { ok: true, detail: "installed" }
      },
    }))
  },
}
