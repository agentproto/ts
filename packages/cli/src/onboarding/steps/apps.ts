/**
 * apps — are the built-in agentproto apps (ops-panel, …) installed? These
 * ship inside the CLI npm package under `node_modules/@agentproto/apps/` and
 * are registered into `~/.agentproto/apps.json` on demand.
 *
 * Beyond the builtins, the daemon's `app_catalog` (`featured` entries, not
 * installed) is surfaced as an opt-in proposal: offered interactively,
 * never applied under --yes, and a silent no-op when the daemon (or its
 * catalog) is unreachable.
 */

import type { OnboardingStep, SetupAction, StepCatalogEntry, StepCheck, StepContext } from "../types.js"

const BUILTIN_APPS = [
  {
    appId: "@agentproto/ops-panel",
    name: "Ops Panel",
    description: "Daemon ops cockpit — watchdog & manager sessions, workspace-filtered session list, GC and cron housekeeping.",
  },
]

/** Featured, not installed, and installable remotely (a catalog entry only
 *  resolves to a real install through the daemon when it carries a remote
 *  `source`; local dir entries are that machine's own business). */
function featuredNotInstalled(catalog: StepCatalogEntry[]): StepCatalogEntry[] {
  return catalog.filter(
    e =>
      e.featured === true &&
      e.installed !== true &&
      e.source !== undefined &&
      (e.source.kind === "git" || e.source.kind === "agentapp"),
  )
}

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

    // Featured catalog entries, best-effort: offline / no daemon / empty
    // catalog means no extra checks at all — same behavior as before.
    const catalog = await ctx.sources.appCatalog().catch(() => null)
    if (catalog) {
      for (const entry of featuredNotInstalled(catalog)) {
        checks.push({
          id: `apps.featured.${entry.appId}`,
          title: entry.name ?? entry.appId,
          status: "warn",
          detail: "featured in the App Store, not installed",
          fix: `agentproto app install ${entry.appId}`,
          data: { appId: entry.appId, featured: true, installed: false },
        })
      }
    }
    return checks
  },
  async plan(checks, ctx) {
    const needed = checks.filter((c) => c.status === "warn")
    if (needed.length === 0) return []
    const actions: SetupAction[] = []
    for (const c of needed) {
      const dir = c.data?.dir
      if (typeof dir === "string") {
        actions.push({
          id: `apps.install.${c.id}`,
          title: `Install ${c.title}`,
          default: true,
          async apply(io) {
            const code = await io.verbs.appInstall(dir)
            if (code !== 0) return { ok: false, detail: `app install exited ${code}` }
            return { ok: true, detail: "installed" }
          },
        })
        continue
      }
      // A featured catalog entry: opt-in only (never applied under --yes),
      // and a no-op pointer in non-interactive mode.
      const appId = typeof c.data?.appId === "string" ? (c.data.appId as string) : null
      if (appId === null) continue
      actions.push({
        id: `apps.install.${c.id}`,
        title: `Install ${c.title}`,
        default: false,
        async apply(io) {
          if (!io.interactive) {
            return { ok: true, detail: "agentproto app store" }
          }
          const code = await io.verbs.appInstallFromCatalog(appId)
          if (code !== 0) return { ok: false, detail: `app install exited ${code}` }
          return { ok: true, detail: "installed" }
        },
      })
    }
    return actions
  },
}
