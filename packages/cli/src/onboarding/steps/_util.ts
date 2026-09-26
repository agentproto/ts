/** Small read-only helpers shared by the onboarding steps. */

import { join } from "node:path"
import type { StepContext } from "../types.js"

export async function pathExists(ctx: StepContext, path: string): Promise<boolean> {
  try {
    await ctx.fs.access(path)
    return true
  } catch {
    return false
  }
}

/** Text of `path`, or `null` when it can't be read. */
export async function readText(ctx: StepContext, path: string): Promise<string | null> {
  try {
    return await ctx.fs.readFile(path)
  } catch {
    return null
  }
}

/** `version` field of a JSON manifest (package.json / plugin.json), or `null`. */
export async function readManifestVersion(ctx: StepContext, path: string): Promise<string | null> {
  const raw = await readText(ctx, path)
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return null
    const version: unknown = Reflect.get(parsed, "version")
    return typeof version === "string" ? version : null
  } catch {
    return null
  }
}

export function expandHome(ctx: StepContext, p: string): string {
  if (p === "~") return ctx.homedir
  return p.startsWith("~/") ? join(ctx.homedir, p.slice(2)) : p
}

/** `/Users/me/x` → `~/x` for display. */
export function tildify(ctx: StepContext, p: string): string {
  return p === ctx.homedir || p.startsWith(`${ctx.homedir}/`) ? `~${p.slice(ctx.homedir.length)}` : p
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
