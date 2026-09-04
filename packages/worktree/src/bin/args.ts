import { resolve } from "node:path"
import type { WorktreeAgentInput } from "../workflow.js"

export const USAGE = `usage: worktree-agent run --repo <abs repo root> --slug <id> --task "<prompt>" --gate "<check cmd>"
  [--base <ref>] [--adapter <slug>] [--deps-cmd "<cmd>"] [--copy-glob <glob>]...
  [--link <path>]... [--write-file <json>]... [--no-cleanup] [--yes]

  --repo        Absolute (or cwd-relative) path to the git repository root.
  --slug        Worktree/branch identifier, e.g. 'fix-flaky-test'.
  --task        The prompt sent to the coding agent.
  --gate        Command run inside the worktree to check the agent's work.
  --base        Ref to cut the worktree branch from. Default 'origin/main'.
  --adapter     Agent adapter slug. Default 'claude-code'.
  --deps-cmd    Command to install deps inside the worktree.
  --copy-glob   Gitignored glob to copy into the worktree (repeatable).
  --link        Gitignored dir/file to symlink from the host repo into the worktree
                before deps (node_modules, sibling workspace repos); repeatable.
  --write-file  JSON {"path","content","mode"?} written into the worktree before
                deps, e.g. generated package-manager config (repeatable).
  --no-cleanup  Keep the worktree's branch after cleanup (still removes the worktree dir).
  --yes         Auto-approve the cleanup step instead of prompting.
`

export class CliUsageError extends Error {}

export interface ParsedCli {
  input: WorktreeAgentInput
  yes: boolean
}

/** Parse `worktree-agent run <flags>` into a `WorktreeAgentInput` + CLI-only options. */
export function parseArgs(argv: readonly string[]): ParsedCli {
  const [cmd, ...rest] = argv
  if (cmd !== "run") {
    throw new CliUsageError(cmd ? `unknown command '${cmd}'\n\n${USAGE}` : USAGE)
  }

  let repoRoot: string | undefined
  let slug: string | undefined
  let task: string | undefined
  let gateCmd: string | undefined
  let base: string | undefined
  let adapter: string | undefined
  let depsCmd: string | undefined
  const copyGlobs: string[] = []
  const linkPaths: string[] = []
  const writeFiles: NonNullable<WorktreeAgentInput["writeFiles"]> = []
  let deleteBranch = true
  let yes = false

  function nextValue(flag: string, i: number): string {
    const value = rest[i]
    if (value === undefined) throw new CliUsageError(`flag '${flag}' requires a value\n\n${USAGE}`)
    return value
  }

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    switch (arg) {
      case "--repo":
        repoRoot = nextValue(arg, ++i)
        break
      case "--slug":
        slug = nextValue(arg, ++i)
        break
      case "--task":
        task = nextValue(arg, ++i)
        break
      case "--gate":
        gateCmd = nextValue(arg, ++i)
        break
      case "--base":
        base = nextValue(arg, ++i)
        break
      case "--adapter":
        adapter = nextValue(arg, ++i)
        break
      case "--deps-cmd":
        depsCmd = nextValue(arg, ++i)
        break
      case "--copy-glob":
        copyGlobs.push(nextValue(arg, ++i))
        break
      case "--link":
        linkPaths.push(nextValue(arg, ++i))
        break
      case "--write-file": {
        const raw = nextValue(arg, ++i)
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          throw new CliUsageError(`--write-file value is not valid JSON: ${raw}\n\n${USAGE}`)
        }
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          typeof (parsed as { path?: unknown }).path !== "string" ||
          typeof (parsed as { content?: unknown }).content !== "string"
        ) {
          throw new CliUsageError(`--write-file requires {"path": string, "content": string, "mode"?: "create"|"append"}: ${raw}\n\n${USAGE}`)
        }
        writeFiles.push(parsed as NonNullable<WorktreeAgentInput["writeFiles"]>[number])
        break
      }
      case "--no-cleanup":
        deleteBranch = false
        break
      case "--yes":
        yes = true
        break
      default:
        throw new CliUsageError(`unrecognized flag '${arg}'\n\n${USAGE}`)
    }
  }

  const missing = [
    !repoRoot && "--repo",
    !slug && "--slug",
    !task && "--task",
    !gateCmd && "--gate",
  ].filter((f): f is string => typeof f === "string")
  if (missing.length > 0) {
    throw new CliUsageError(`missing required flag(s): ${missing.join(", ")}\n\n${USAGE}`)
  }

  const input: WorktreeAgentInput = {
    repoRoot: resolve(repoRoot!),
    slug: slug!,
    task: task!,
    gateCmd: gateCmd!,
    deleteBranch,
    ...(base !== undefined ? { base } : {}),
    ...(adapter !== undefined ? { adapter } : {}),
    ...(depsCmd !== undefined ? { depsCmd } : {}),
    ...(copyGlobs.length > 0 ? { copyGlobs } : {}),
    ...(linkPaths.length > 0 ? { linkPaths } : {}),
    ...(writeFiles.length > 0 ? { writeFiles } : {}),
  }
  return { input, yes }
}
