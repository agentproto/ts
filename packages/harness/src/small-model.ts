/**
 * Pin a CLI's auxiliary "small model" to the session's own model.
 *
 * opencode runs a second model for background chores (session titles,
 * summaries). Unless `small_model` is configured it picks one itself, and on
 * OpenCode Zen that pick is a PAID model (GPT-5.4 Nano) even when the session
 * runs a `-free` one: every free-model session then logs a `402 Rejected` per
 * title call, and would bill as soon as the key held credit. Pointing the
 * small model at the session model keeps the whole session on one route and
 * one bill.
 *
 * The value is layered into the CLI's inline JSON config env var
 * (`OPENCODE_CONFIG_CONTENT`), the highest-precedence config layer — so it is
 * only set when nobody chose already: not when the inline config carries the
 * key, not when the user's own config files set it, not when the spawn passes
 * the adapter's explicit option (which wins over the session model).
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { AgentCliSmallModel } from "./types.js"

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Every directory from `cwd` up to the filesystem root, nearest first. */
function ancestors(cwd: string): string[] {
  const out: string[] = []
  let dir = resolve(cwd)
  for (;;) {
    out.push(dir)
    const parent = dirname(dir)
    if (parent === dir) return out
    dir = parent
  }
}

/**
 * Config files the CLI may read `key` from. A superset of what it actually
 * loads (project files are looked up to `/`, not just to the git root): a
 * false hit only means we leave the CLI's own default alone, which is the
 * behaviour before this pin existed.
 */
function userConfigFiles(
  decl: NonNullable<AgentCliSmallModel["userConfig"]>,
  cwd: string,
  env: Record<string, string | undefined>,
): string[] {
  const home = env.HOME || homedir()
  const files: string[] = []
  const xdgConfig = env.XDG_CONFIG_HOME || join(home, ".config")
  for (const f of decl.globalFiles ?? []) files.push(join(xdgConfig, f))
  for (const name of decl.fileEnv ?? []) {
    if (env[name]) files.push(env[name]!)
  }
  for (const name of decl.dirEnv ?? []) {
    if (env[name]) for (const f of decl.dirFiles ?? []) files.push(join(env[name]!, f))
  }
  const dirs = [...ancestors(cwd), home]
  const projectDisabled = !!(decl.projectDisableEnv && env[decl.projectDisableEnv])
  for (const dir of dirs) {
    if (!projectDisabled) for (const f of decl.projectFiles ?? []) files.push(join(dir, f))
    for (const f of decl.dirFiles ?? []) files.push(join(dir, f))
  }
  return files
}

/**
 * Text match, not a parse: the files are JSONC (comments, trailing commas). A
 * commented-out key also matches — a false hit, so we stay out of the way.
 */
function fileSetsKey(file: string, key: string): boolean {
  try {
    if (!existsSync(file)) return false
    return readFileSync(file, "utf8").includes(`"${key}"`)
  } catch {
    return false
  }
}

/**
 * The env patch pinning the small model, or `undefined` to leave the spawn
 * env alone. `env` is the FINAL spawn env (ambient + mode/option + auth +
 * host layers), so a value any layer already put in the inline config wins.
 */
export function resolveSmallModelEnv(
  decl: AgentCliSmallModel | undefined,
  input: {
    model?: unknown
    options?: Record<string, unknown>
    env: Record<string, string>
    cwd: string
  },
): Record<string, string> | undefined {
  if (!decl) return undefined
  const explicit = decl.option ? input.options?.[decl.option] : undefined
  const value =
    typeof explicit === "string" && explicit
      ? explicit
      : typeof input.model === "string" && input.model
        ? input.model
        : undefined
  if (!value) return undefined

  const prior = input.env[decl.env]
  let inline: Record<string, unknown> = {}
  if (prior !== undefined && prior !== "") {
    let parsed: unknown
    try {
      parsed = JSON.parse(prior)
    } catch {
      // Not JSON — the CLI will complain on its own; never rewrite it.
      return undefined
    }
    if (!isPlainObject(parsed)) return undefined
    if (parsed[decl.key] !== undefined) return undefined
    inline = parsed
  }

  // An explicit option is the operator's pick for THIS spawn — it beats
  // whatever the user's config files say. The session-model default does not.
  if (!explicit && decl.userConfig) {
    const files = userConfigFiles(decl.userConfig, input.cwd, input.env)
    if (files.some(f => fileSetsKey(f, decl.key))) return undefined
  }

  return { [decl.env]: JSON.stringify({ ...inline, [decl.key]: value }) }
}
