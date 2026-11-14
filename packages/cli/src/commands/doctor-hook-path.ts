/**
 * `agentproto doctor` check: the command the Claude Code hooks run
 * (`agentproto hook inbox`, written to `~/.claude/settings.json`) must resolve
 * on the PATH a `claude` started from a login shell sees. When it does not,
 * every hook prints `/bin/sh: agentproto: command not found` and the session
 * never gets its `cc:` row.
 *
 * Read-only. The `--fix` side only builds the diff that would pin an absolute
 * path into the hook commands ({@link proposeHookPathFix}); nothing is ever
 * written here.
 */

import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { isAbsolute } from "node:path"
import type { StepCheck, StepReport } from "../onboarding/types.js"

export const HOOK_STEP_ID = "hooks"
const BIN = "agentproto"

/** Where to look a command up: the user's login shell (what a terminal-launched
 *  `claude` inherits) or the PATH of this very process (where doctor runs). */
export type HookBinLookup = (name: string, via: "login-shell" | "current-path") => Promise<string | null>

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v)

/** Every `agentproto hook …` command string in a settings object, with the
 *  JSON pointer-ish location for the diff. Only bare `agentproto` ones count:
 *  an absolute path in the command is already immune to PATH. */
function bareHookCommands(settings: Json): string[] {
  const out: string[] = []
  const hooks = settings.hooks
  if (!isObject(hooks)) return out
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue
    for (const e of entries) {
      if (!isObject(e) || !Array.isArray(e.hooks)) continue
      for (const h of e.hooks) {
        if (isObject(h) && typeof h.command === "string" && /^agentproto\s+hook(\s|$)/.test(h.command)) {
          out.push(h.command)
        }
      }
    }
  }
  return out
}

function readSettings(file: string): Json | null {
  if (!existsSync(file)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

export interface HookPathResult {
  report: StepReport | null
  /** Proposed settings.json change, only when the check warned and the
   *  absolute path is known. Never applied. */
  proposal?: { file: string; absolute: string; diff: string }
}

function quote(p: string): string {
  return /^[A-Za-z0-9_./@:+-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`
}

/** The diff `--fix` offers: each bare hook command gets the absolute binary. */
export function proposeHookPathFix(file: string, absolute: string): string | null {
  const settings = readSettings(file)
  if (!settings) return null
  const cmds = [...new Set(bareHookCommands(settings))]
  if (cmds.length === 0) return null
  return cmds
    .flatMap((c) => [`- "command": "${c}"`, `+ "command": "${quote(absolute)}${c.slice(BIN.length)}"`])
    .join("\n")
}

export async function checkHookPath(file: string, lookup: HookBinLookup): Promise<HookPathResult> {
  const settings = readSettings(file)
  if (!settings) return { report: null }
  const cmds = bareHookCommands(settings)
  if (cmds.length === 0) return { report: null }
  const started = Date.now()
  const inLogin = await lookup(BIN, "login-shell")
  const title = `Claude Code hook command \`${BIN} hook\` resolves in your login shell PATH`
  let check: StepCheck
  let proposal: HookPathResult["proposal"]
  if (inLogin) {
    check = { id: "hooks.path", title, status: "ok", detail: inLogin, data: { resolved: inLogin, file } }
  } else {
    const current = await lookup(BIN, "current-path")
    const absolute = current && isAbsolute(current) ? current : null
    const dir = absolute ? absolute.slice(0, absolute.lastIndexOf("/")) : null
    const exportLine = dir ? `export PATH="${dir}:$PATH"` : `export PATH="<dir containing ${BIN}>:$PATH"`
    check = {
      id: "hooks.path",
      title,
      status: "warn",
      detail:
        `${file} runs \`${BIN} hook …\` but a login shell cannot find \`${BIN}\`: a claude started there prints ` +
        `"${BIN}: command not found" on every hook and gets no cc: row`,
      fix:
        `add \`${exportLine}\` to your shell profile (~/.zprofile or ~/.profile), or put the absolute path in the hook ` +
        `commands${absolute ? ` (\`agentproto doctor --fix\` shows the diff, it does not write it)` : ""}`,
      data: { file, commands: [...new Set(cmds)], ...(absolute ? { absolute } : {}) },
    }
    if (absolute) {
      const diff = proposeHookPathFix(file, absolute)
      if (diff) proposal = { file, absolute, diff }
    }
  }
  return {
    report: { id: HOOK_STEP_ID, title: "Claude Code hooks", required: false, checks: [check], durationMs: Date.now() - started },
    ...(proposal ? { proposal } : {}),
  }
}

/** Real lookup: `$SHELL -l -c 'command -v agentproto'` for the login shell,
 *  `PATH` of this process for the current one. The login lookup starts from a
 * minimal PATH so an inherited nvm path cannot mask a missing profile entry. */
export const realHookBinLookup: HookBinLookup = (name, via) =>
  new Promise((resolve) => {
    const shell = process.env.SHELL ?? "/bin/sh"
    const [cmd, args] =
      via === "login-shell"
        ? ([shell, ["-l", "-c", `command -v ${name}`]] as const)
        : (["/bin/sh", ["-c", `command -v ${name}`]] as const)
    execFile(cmd, [...args], { timeout: 10_000, env: via === "current-path" ? process.env : { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } }, (err, stdout) => {
      if (err) return resolve(null)
      const line = stdout.split("\n").map((l) => l.trim()).filter(Boolean).pop()
      resolve(line && isAbsolute(line) ? line : null)
    })
  })
