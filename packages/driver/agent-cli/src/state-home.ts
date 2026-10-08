/**
 * Isolated adapter state home for OS-confined spawns.
 *
 * Some CLIs keep mutable runtime state in a home directory under `$HOME`
 * (codex: `~/.codex` — a sqlite state db, `tmp/arg0` PATH aliases, session
 * rollouts). The OS sandbox denies `$HOME` outright, so a confined spawn of
 * such a CLI dies at startup ("failed to initialize sqlite state runtime").
 *
 * Granting the REAL home writable would let a confined agent rewrite the
 * operator's own config (codex `config.toml`: MCP servers, sandbox mode) for
 * every later, unconfined run, and read every other session's transcripts.
 * Instead the confined spawn gets its own home — the per-session-lineage
 * `configDir` when the host keys one (so native resume finds its rollouts
 * after a respawn), else a throwaway temp dir — pointed at by the CLI's home
 * env var. Only the files the definition lists in `share` (the login file)
 * are symlinked back to the real home, and only those exact files are
 * granted through the sandbox, so a token refresh written through the link
 * lands in the operator's real login rather than a diverging copy.
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, unlinkSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import type { AgentCliStateHome } from "./types.js"

export interface IsolatedStateHome {
  /** The per-spawn home the CLI's `env` var now points at. */
  dir: string
  /** Read+write grants for the sandbox: the home itself + each shared file's real path. */
  writePaths: string[]
}

/** The operator's real home for this CLI: the ambient env override, else `~/<defaultDir>`. */
export function realStateHome(stateHome: AgentCliStateHome, env: Record<string, string | undefined>): string {
  const fromEnv = env[stateHome.env]
  if (fromEnv && isAbsolute(fromEnv)) return fromEnv
  return resolve(homedir(), stateHome.defaultDir)
}

export function prepareIsolatedStateHome(
  stateHome: AgentCliStateHome,
  opts: { configDir?: string; env: Record<string, string | undefined> },
): IsolatedStateHome {
  const real = realStateHome(stateHome, opts.env)
  let dir: string
  if (opts.configDir) {
    dir = opts.configDir
    mkdirSync(dir, { recursive: true })
  } else {
    dir = mkdtempSync(join(tmpdir(), `agentproto-${stateHome.env.toLowerCase()}-`))
  }
  const writePaths = [dir]
  for (const name of stateHome.share ?? []) {
    const target = join(real, name)
    const link = join(dir, name)
    // Re-assert every spawn: a reused lineage dir may hold a stale link, or a
    // regular file the CLI wrote while the real one was absent.
    try {
      lstatSync(link)
      unlinkSync(link)
    } catch {
      // absent — nothing to replace
    }
    if (!existsSync(target)) continue
    symlinkSync(target, link)
    // The sandbox checks the resolved path, so grant the real file.
    writePaths.push(realpathSync(target))
  }
  return { dir, writePaths }
}
