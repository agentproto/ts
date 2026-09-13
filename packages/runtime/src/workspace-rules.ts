/**
 * Daemon-side per-workspace RULES.md resolution + injection (WP-R4).
 *
 * Complementary to — and distinct from — `agents-md.ts` (WP-R2):
 *   - AGENTS.md is a per-REPO file the daemon resolves from `cwd`, walking
 *     up to the repo's git toplevel, and injects into the spawn's composed
 *     prompt. It is root-cwd-scoped, bounded by the repo.
 *   - RULES.md is a per-WORKSPACE file, read from the workspace's state
 *     bucket (`~/.agentproto/workspaces/<slug>/RULES.md`), injected into
 *     LITERALLY EVERY spawn in that workspace — root and nested, no depth
 *     gate. It carries the standing, workspace-wide discipline a supervisor
 *     would otherwise have to hand-type into every brief: "main checkout
 *     untouchable", "PR-only, never merge", "no AI attribution", named
 *     staging, and so on.
 *
 * The file is freeform markdown, human-authored, no schema — mirroring
 * `AGENTS.md`'s file-based precedent. A workspace opts in by a human
 * creating the file; absent means nothing extra is injected.
 *
 * ## Security: the slug→path read is membership-validated, never hand-rolled
 *
 * `workspaceSlug` is caller input on a spawn request, and naively joining it
 * into a filesystem path hands an attacker `../../` under the daemon's own
 * state root as the daemon's UID. That is exactly why `workspace-buckets.ts`
 * owns this pattern — read its docblock. We build the RULES.md path with the
 * SAME primitives (`BUCKETS_ROOT()` + `bucketDir`) and validate the slug
 * through `resolveBucketSlug` against the workspaces REGISTRY (not caller
 * input): an unregistered/malicious-looking slug (`../` and friends) fails to
 * match and lands in `default`, so the resolved RULES.md path can never
 * escape `~/.agentproto/workspaces`.
 */

import { promises as fs } from "node:fs"
import { join } from "node:path"
import {
  BUCKETS_ROOT,
  bucketDir,
  readRegisteredSlugs,
  resolveBucketSlug,
} from "./workspace-buckets.js"

/** The state-bucket-relative name of the per-workspace rules file. */
export const RULES_MD_FILE = "RULES.md"

/** Sane hard cap for a rules file (KiB). Rules files are expected to be
 *  short and hand-authored and are read on EVERY spawn; a multi-MB runaway
 *  file should be truncated rather than flooding every composed prompt.
 *  There is deliberately NO inline/pointer split here — rules always ride
 *  along in full (up to this cap) — see the module docblock. Files at or
 *  under the cap are inlined whole. */
export const RULES_MD_MAX_KB = 256

export interface WorkspaceRulesResolution {
  /** Absolute path of the resolved RULES.md. Undefined when absent (or a
   *  read failure degraded to absent). */
  path?: string
  /** Full text of the RULES.md, inlined. Present exactly when `block` is. */
  content?: string
  /** The prompt block to inject, or undefined when absent. */
  block?: string
}

/** Injectable fs boundary, so resolution is testable without the real
 *  `~/.agentproto` / bucket root on the machine running the suite. */
export interface WorkspaceRulesFs {
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<Buffer>
}

const realFs: WorkspaceRulesFs = {
  exists: async path => {
    try {
      await fs.access(path)
      return true
    } catch {
      return false
    }
  },
  read: (path: string) => fs.readFile(path),
}

export interface ResolveWorkspaceRulesDeps {
  /** Bucket root. Defaults to the real `BUCKETS_ROOT()`
   *  (`~/.agentproto/workspaces`); tests inject a temp dir. */
  root?: string
  /** Registered workspace slugs. Defaults to `readRegisteredSlugs()` (the
   *  workspaces registry — never caller input). */
  registered?: ReadonlySet<string>
  /** Injected fs. */
  fs?: WorkspaceRulesFs
  /** Size cap in KiB. Defaults to `RULES_MD_MAX_KB`. */
  maxKb?: number
}

function rulesBlockUi(path: string, content: string): string {
  return `--- Workspace RULES.md (${path}) ---\n${content}\n--- end Workspace RULES.md ---`
}

/**
 * Resolve + shape the per-workspace RULES.md for a spawn at `slug`.
 *
 * The slug is validated through `resolveBucketSlug` (membership against the
 * workspaces registry) BEFORE it becomes a directory name, so the RULES.md
 * path can never escape the bucket root — see the module docblock. No file
 * ⇒ absent (inject nothing). A file over the hard cap is inlined truncated
 * to the cap with a console warning. Always inline when present — no
 * pointer mode.
 *
 * @throws if the resolved RULES.md exists but can't be read (a real
 *   failure, not a "no file" — `exists` already gated presence). Callers
 *   wrap this in a try/catch fall-through-to-absent (see `session-spawn.ts`)
 *   so a read failure never blocks a spawn.
 */
export async function resolveWorkspaceRules(
  slug: string | undefined,
  deps: ResolveWorkspaceRulesDeps = {},
): Promise<WorkspaceRulesResolution> {
  const root = deps.root ?? BUCKETS_ROOT()
  const registered = deps.registered ?? readRegisteredSlugs()
  const fsIo = deps.fs ?? realFs
  const safeSlug = resolveBucketSlug(slug, registered)
  const path = join(bucketDir(root, safeSlug), RULES_MD_FILE)
  if (!(await fsIo.exists(path))) return {}
  const bytes = await fsIo.read(path)
  const maxBytes = (deps.maxKb ?? RULES_MD_MAX_KB) * 1024
  let content = bytes.toString("utf8")
  if (bytes.length > maxBytes) {
    console.warn(
      `[workspace-rules] ${path} is ${bytes.length} bytes — over the ` +
        `${RULES_MD_MAX_KB} KiB hard cap; inlining only the first ${maxBytes} bytes.`,
    )
    content = content.slice(0, maxBytes)
  }
  return { path, content, block: rulesBlockUi(path, content) }
}
