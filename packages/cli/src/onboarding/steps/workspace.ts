/**
 * workspace — at least one registered workspace, and whether the current
 * directory is inside one.
 */

import { basename, resolve, sep } from "node:path"
import { sanitizeSlug } from "@agentproto/runtime/workspaces-config"
import type { OnboardingStep, StepContext } from "../types.js"
import { errorMessage } from "./_util.js"

function isInside(dir: string, root: string): boolean {
  const r = resolve(root)
  const d = resolve(dir)
  return d === r || d.startsWith(r.endsWith(sep) ? r : r + sep)
}

function addFix(ctx: StepContext): string {
  return `agentproto workspace add . --slug ${sanitizeSlug(basename(ctx.cwd))}`
}

export const workspaceStep: OnboardingStep = {
  id: "workspace",
  title: "Workspace",
  required: true,
  async detect(ctx) {
    let config
    try {
      config = await ctx.sources.loadWorkspaces()
    } catch (err) {
      return [
        {
          id: "workspace.registered",
          title: "Registered workspaces",
          status: "broken",
          detail: errorMessage(err),
          fix: "agentproto workspace list",
        },
      ]
    }
    const slugs = config.workspaces.map((w) => w.slug)
    if (config.workspaces.length === 0) {
      return [
        {
          id: "workspace.registered",
          title: "Registered workspaces",
          status: "missing",
          detail: "no workspace registered",
          fix: addFix(ctx),
          data: { count: 0 },
        },
      ]
    }
    const registered = {
      id: "workspace.registered",
      title: "Registered workspaces",
      status: "ok" as const,
      detail: `${slugs.length} registered${config.active ? `, active: ${config.active}` : ""}`,
      data: { count: slugs.length, active: config.active ?? null, slugs },
    }
    // Deepest match wins when workspaces nest.
    const containing = config.workspaces
      .filter((w) => isInside(ctx.cwd, w.path))
      .sort((a, b) => b.path.length - a.path.length)[0]
    const cwd = containing
      ? {
          id: "workspace.cwd",
          title: "Current directory",
          status: "ok" as const,
          detail: `inside workspace "${containing.slug}"`,
          data: { cwd: ctx.cwd, workspace: containing.slug },
        }
      : {
          id: "workspace.cwd",
          title: "Current directory",
          status: "warn" as const,
          detail: "not inside a registered workspace",
          fix: addFix(ctx),
          data: { cwd: ctx.cwd, workspace: null },
        }
    return [registered, cwd]
  },
}
