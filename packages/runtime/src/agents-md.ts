/**
 * Daemon-side AGENTS.md resolution + injection (WP-R2).
 *
 * The daemon historically had ZERO first-class handling of `AGENTS.md` — it
 * was read only when an adapter happened to do so natively (opencode by its
 * own convention, claude-code via `CLAUDE.md`, hermes not at all), and the
 * supervisor brief told a child to "go read AGENTS.md" by hand, which is a
 * loterie, not a guarantee. This module makes the daemon resolve and inject
 * it itself, adapter-agnostic, at spawn time — the same way it already
 * composes the role disposition (see `role.ts`'s `composeRoleContext`).
 *
 * Resolution runs once per spawn, from the session's resolved `cwd`:
 *   - walk UP directory by directory, checking for an `AGENTS.md` at each
 *     level; the FIRST one found (nearest to `cwd`) wins.
 *   - the walk is bounded by the git toplevel of `cwd`'s own repo
 *     (`git rev-parse --show-toplevel` from `cwd`) — it never walks past it
 *     into an outer/parent repo. A nested repo has its own `.git`, so git's
 *     toplevel resolves to the nested root and the walk stops exactly there.
 *   - if `cwd` is not inside a git repo at all, only `cwd` itself is checked
 *     (no walk), falling through to "absent" when nothing is there.
 *
 * Injection is a block in the child's single composed initial prompt (there
 * is no separate system-prompt channel — see `session-spawn.ts`'s
 * `effectivePrompt` construction): a full inline copy when the file is small
 * enough, a pointer to read it first when it's large, or nothing extra when
 * absent — plus a standing cd-contract sentence regardless of mode.
 */

import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { loadConfig } from "./config.js"

export type AgentsMdMode = "inline" | "pointer" | "absent"

/** The resolved AGENTS.md's absolute path; undefined when mode is "absent". */

export interface AgentsMdResolution {
  mode: AgentsMdMode
  /** Absolute path of the resolved AGENTS.md. Undefined when mode is
   *  `"absent"`. */
  path?: string
  /** Full text of the AGENTS.md (inline mode only). */
  content?: string
  /** The prompt block to inject (full inline text or a pointer), or
   *  undefined when absent. Excludes the always-present cd-contract line. */
  block?: string
  /** The standing cd-contract sentence, present in every mode. */
  contractLine: string
}

/**
 * Injected fs boundary, so the pure walk/resolution logic is testable
 * without a live daemon, real filesystem, or real git. Defaults to real
 * implementations.
 */
export interface AgentsMdFs {
  /** Resolve `true` when an `AGENTS.md` exists at `path`. */
  exists: (path: string) => Promise<boolean>
  /** Read a file's bytes (used for both size + inline content). */
  read: (path: string) => Promise<Buffer>
  /** The git toplevel of `cwd`'s own repo, or `undefined` when `cwd` is not
   *  inside a git repo at all. */
  gitToplevel: (cwd: string) => Promise<string | undefined>
}

/** Config default for `agentsMd.inlineMaxKb` — see {@link AgentsMdConfig}. */
export const DEFAULT_AGENTS_MD_INLINE_MAX_KB = 8

/**
 * Resolve the effective `agentsMd.inlineMaxKb` policy — config field >
 * hardcoded default. No env override (not part of the approved design).
 */
export async function loadAgentsMdInlineMaxKb(
  loadCfg: () => Promise<{ agentsMd?: { inlineMaxKb?: number } }> = loadConfig,
): Promise<number> {
  const cfg = await loadCfg()
  return cfg.agentsMd?.inlineMaxKb ?? DEFAULT_AGENTS_MD_INLINE_MAX_KB
}

const realFs: AgentsMdFs = {
  exists: async path => {
    try {
      await fs.access(path)
      return true
    } catch {
      return false
    }
  },
  read: (path: string) => fs.readFile(path),
  gitToplevel: async cwd =>
    new Promise<string | undefined>(resolvePromise => {
      execFile("git", ["rev-parse", "--show-toplevel"], { cwd }, (err, stdout) => {
        resolvePromise(err ? undefined : stdout.trim() || undefined)
      })
    }),
}

/**
 * Resolve the nearest `AGENTS.md` for `cwd` — the pure walk. Walks up from
 * `cwd` checking each level (nearest wins), bounded by `cwd`'s own git
 * toplevel; a `cwd` not in any git repo checks only `cwd` itself.
 */
export async function findAgentsMdPath(
  cwd: string,
  fsIo: AgentsMdFs = realFs,
): Promise<string | undefined> {
  const toplevel = await fsIo.gitToplevel(cwd)
  // Not in a git repo ⇒ only `cwd` itself is in scope — no walk.
  if (toplevel === undefined) {
    const candidate = join(cwd, "AGENTS.md")
    return (await fsIo.exists(candidate)) ? candidate : undefined
  }
  const root = resolve(toplevel)
  let dir = resolve(cwd)
  for (;;) {
    const candidate = join(dir, "AGENTS.md")
    if (await fsIo.exists(candidate)) return candidate
    // Exit AFTER checking the toplevel's own AGENTS.md (`git rev-parse`
    // guarantees `cwd` sits at or below its toplevel, so the walk always
    // reaches the root rather than looping past filesystem root).
    if (dir === root) return undefined
    const parent = dirname(dir)
    if (parent === dir) return undefined // defensive: never past fs root.
    dir = parent
  }
}

const inlineHeader = (path: string) => `--- AGENTS.md (${path}) ---`
const inlineFooter = (path: string) => `--- end AGENTS.md ---`

function inlineBlock(path: string, content: string): string {
  return `${inlineHeader(path)}\n${content}\n${inlineFooter(path)}`
}

const pointerBlock = (path: string): string =>
  `This repo has an AGENTS.md at "${path}" — read it before your first tool ` +
  `call; it is the committed definition of done and overrides ad-hoc ` +
  `instructions.`

/**
 * The standing cd-contract sentence, present in every mode: the daemon fixes
 * this contract once at spawn from the session's resolved `cwd` and cannot
 * follow the agent — a `cd` elsewhere (a nested repo included) is the agent's
 * own responsibility to re-resolve.
 */
export const cdContractLine =
  `The daemon resolves and fixes this AGENTS.md contract ONCE at spawn from ` +
  `your resolved cwd — a \`cd\` outside that repo root is NOT tracked by the ` +
  `daemon. If you \`cd\` somewhere else (a nested repo included), YOU are ` +
  `responsible for re-resolving and re-reading the AGENTS.md of wherever you ` +
  `end up.`

/**
 * Resolve + shape the AGENTS.md for a spawn at `cwd`. Decides inline vs
 * pointer against `inlineMaxKb` KB: byte size `<` the threshold ⇒ inline the
 * full content; `>=` ⇒ pointer-mode; none found ⇒ absent. Always carries the
 * cd-contract line. Pure over the injected fs; the only side effect is
 * reading the file.
 *
 * @throws if the resolved AGENTS.md can't be read (a real failure, not a
 *   "no file" — `findAgentsMdPath` already gated existence).
 */
export async function resolveAgentsMd(
  cwd: string,
  inlineMaxKb: number = DEFAULT_AGENTS_MD_INLINE_MAX_KB,
  fsIo: AgentsMdFs = realFs,
): Promise<AgentsMdResolution> {
  const path = await findAgentsMdPath(cwd, fsIo)
  if (path === undefined) {
    return { mode: "absent", contractLine: cdContractLine }
  }
  const bytes = await fsIo.read(path)
  if (bytes.length / 1024 >= inlineMaxKb) {
    return { mode: "pointer", path, contractLine: cdContractLine, block: pointerBlock(path) }
  }
  return {
    mode: "inline",
    path,
    content: bytes.toString("utf8"),
    contractLine: cdContractLine,
    block: inlineBlock(path, bytes.toString("utf8")),
  }
}