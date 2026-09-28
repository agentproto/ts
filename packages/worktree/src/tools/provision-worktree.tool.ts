import { z } from "zod"
import { defineTool } from "@agentproto/tool"

/**
 * AIP-14 contract: create a git worktree off a base ref, on its own branch,
 * optionally installing deps and copying gitignored files (secrets) into it.
 * Agnostic — no hardcoded package manager or env layout; both are inputs.
 */
export const provisionWorktreeTool = defineTool({
  id: "worktree.provision",
  description:
    "Create a git worktree for `repoRoot` at a sibling '_worktrees/<slug>' " +
    "directory (or `dir`, when given), on a new branch 'wt/<slug>' (or " +
    "`branch`, when given) cut from `base`. `depsCmd` runs inside the new " +
    "worktree afterwards (e.g. install deps). `copyGlobs` copies matching " +
    "files (incl. gitignored, e.g. secrets) from `repoRoot` into the " +
    "worktree. `cloneGlobs` clones matching dirs/files (e.g. " +
    "`node_modules`) from `repoRoot` before `depsCmd`, copy-on-write where " +
    "supported, else a plain copy — never a symlink. `linkPaths` symlinks " +
    "gitignored, expensive-to-recreate paths from `repoRoot` before " +
    "`depsCmd`. `writeFiles` writes/appends generated, worktree-specific " +
    "config before `depsCmd`; see each field's own description for its " +
    "`mode` and clobber rules. Each of `depsCmd`/`linkPaths`/`copyGlobs`/" +
    "`cloneGlobs`/`writeFiles`, when omitted, falls back first to the " +
    "same-named field in `<repoRoot>/.agentproto/worktree.json` (local, " +
    "host-owned, gitignored — read off disk, never a branch), then — " +
    "`depsCmd`/`linkPaths` only — to `worktree.depsCmd`/`worktree.linkPaths` " +
    "in the base tree's COMMITTED agentproto.json (same `runSetup` gate as " +
    "the setup hooks below). An explicit input wins over both defaults; the " +
    "local file wins over the committed one. Local `writeFiles` entries may " +
    "use a `{slug}` placeholder in `path`/`content`, substituted per call. " +
    "Also writes a creation-provenance marker into the worktree's private " +
    "gitdir.",
  version: "0.3.0",
  inputSchema: z.object({
    repoRoot: z.string().describe("Absolute path to the git repository root."),
    base: z
      .string()
      .optional()
      .describe("Ref the new branch is cut from. Default 'origin/main'."),
    slug: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be lowercase kebab-case")
      .describe("Short identifier — names both the worktree directory and its branch."),
    branch: z
      .string()
      .optional()
      .describe("Branch name for the new worktree. Default 'wt/<slug>'."),
    dir: z
      .string()
      .optional()
      .describe("Absolute path for the new worktree. Default '<repoRoot>/../_worktrees/<slug>'."),
    depsCmd: z
      .string()
      .optional()
      .describe("Shell command run inside the worktree after creation, e.g. 'pnpm install --prefer-offline'."),
    copyGlobs: z
      .array(z.string())
      .optional()
      .describe("Glob patterns (relative to repoRoot) of gitignored files to copy into the worktree, e.g. 'envs/**/.env.local'."),
    cloneGlobs: z
      .array(z.string())
      .optional()
      .describe(
        "Glob patterns (relative to repoRoot) of gitignored dirs/files to clone into the worktree before depsCmd, e.g. 'node_modules'. Copy-on-write where the filesystem supports it, falling back to a plain copy — never a symlink. Each pattern segment may use '*'/'?'; '**' is not supported (a clone target is a single named entry per level, matched and copied as a whole rather than enumerated file-by-file).",
      ),
    linkPaths: z
      .array(z.string())
      .optional()
      .describe("Relative paths (dirs or files) symlinked from repoRoot into the worktree before depsCmd, e.g. 'node_modules' or a gitignored sibling workspace repo. Lets the workspace graph resolve without a full reinstall."),
    writeFiles: z
      .array(
        z.object({
          path: z.string().describe("Path relative to the worktree root."),
          content: z.string().describe("File content, written or appended verbatim."),
          mode: z
            .enum(["create", "append"])
            .optional()
            .describe("'create' (default): write only if path doesn't already exist. 'append': always append (creating if missing); if git tracks the path, it's marked skip-worktree afterwards so the change never shows as a local modification."),
        }),
      )
      .optional()
      .describe("Files written into the worktree before depsCmd runs, e.g. a package-manager config generated for this specific worktree."),
    runSetup: z
      .boolean()
      .optional()
      .describe("Apply the declarative worktree lifecycle: `<repoRoot>/.agentproto/worktree.json` (local) and the base tree's agentproto.json (committed) as fallbacks for the inputs above, then the committed config's `worktree.setup` hooks after creation. Default true; a failing setup hook fails provisioning."),
    setupLogPath: z
      .string()
      .optional()
      .describe("Absolute path to append the FULL, unfiltered stdout+stderr of every `worktree.setup` hook command to (success or failure). Caller-provided — typically a path under the spawning session's own directory, so the full output outlives a subsequently-reclaimed worktree. Best-effort: a write failure never fails provisioning. When omitted, only a short, noise-filtered tail survives in a failing hook's own error message."),
    retrySetupOnFailure: z
      .boolean()
      .optional()
      .describe("Re-run a failing `worktree.setup` command exactly once before giving up — a complement to (never a substitute for) a real root-cause fix, meant for unattended callers with no way to retry themselves short of provisioning an entirely new worktree. Default false: an interactive caller (e.g. `agentproto worktree new`) sees a genuine failure on the first try rather than waiting through an identical rerun."),
  }),
  outputSchema: z.object({
    cwd: z.string().describe("Absolute path to the created worktree."),
    branch: z.string().describe("The branch the worktree was created on."),
  }),
  mutates: ["fs:write"],
  approval: "auto",
  riskLevel: 1,
})
