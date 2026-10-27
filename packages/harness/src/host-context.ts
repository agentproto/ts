import { realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"

/** Adapters with a verified switch for excluding host instruction files. */
export function agentCliSupportsHostContextIsolation(adapterId: string): boolean {
  return adapterId === "claude-code"
}

// claudeMdExcludes entries are picomatch globs, so a literal path with glob
// metacharacters must be escaped or it silently matches nothing.
function escapeGlob(p: string): string {
  return p.replace(/[\\*?[\]{}()!+@]/g, "\\$&")
}

function ancestors(dir: string): string[] {
  const out: string[] = []
  let cur = dirname(dir)
  for (;;) {
    out.push(cur)
    const parent = dirname(cur)
    if (parent === cur) return out
    cur = parent
  }
}

/**
 * `claudeMdExcludes` entries covering every instruction file Claude Code
 * would load from a STRICT ancestor of `cwd` (the host monorepo around an
 * installed app). `cwd`'s own CLAUDE.md is deliberately left loadable — it
 * is the app's. Both the lexical and the symlink-resolved ancestor chains
 * are covered, since the SDK may walk either.
 */
export function hostContextExcludes(cwd: string): string[] {
  const abs = resolve(cwd)
  let real = abs
  try {
    real = realpathSync(abs)
  } catch {
    // cwd not created yet — the lexical chain is all there is
  }
  const dirs = new Set([...ancestors(abs), ...ancestors(real)])
  const out: string[] = []
  for (const d of dirs) {
    const base = d === "/" ? "" : escapeGlob(d)
    out.push(
      `${base}/CLAUDE.md`,
      `${base}/CLAUDE.local.md`,
      `${base}/.claude/CLAUDE.md`,
      `${base}/.claude/rules/**`,
    )
  }
  return out
}
