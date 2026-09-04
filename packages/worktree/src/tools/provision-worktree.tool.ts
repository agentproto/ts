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
    "`branch`, when given) cut from `base`. If `depsCmd` is given, it runs " +
    "inside the new worktree afterwards (e.g. install deps). If `copyGlobs` " +
    "is given, matching files under `repoRoot` (including gitignored ones, " +
    "e.g. local secrets) are copied into the worktree at the same relative " +
    "path. If `linkPaths` is given, each is symlinked from `repoRoot` into " +
    "the worktree before `depsCmd` runs — for gitignored, expensive-to-" +
    "recreate trees a fresh worktree lacks (node_modules, sibling workspace " +
    "repos) so the workspace graph resolves without a full reinstall. If " +
    "`writeFiles` is given, each entry's `content` is written into the " +
    "worktree at `path` before `depsCmd` runs — for generated, worktree-" +
    "specific config a tool invoked by `depsCmd` needs to see (e.g. a " +
    "package-manager config pointing a cache/store dir outside the " +
    "worktree, so it isn't shared with — or clobbered by — a sibling " +
    "worktree). `mode: \"create\"` (default) skips an entry whose path " +
    "already exists, matching `linkPaths`' never-clobber rule; " +
    "`mode: \"append\"` always appends (creating the file if missing) and, " +
    "if git already tracks that path, marks it `skip-worktree` afterwards " +
    "so the tweak never shows up as a local modification the caller could " +
    "accidentally commit — callers are responsible for making the content " +
    "itself idempotent (e.g. checking `repoRoot`'s copy of the file for the " +
    "line before including the entry, since a fresh worktree's tracked " +
    "files start as a byte-identical checkout). Also writes a creation-" +
    "provenance marker into the worktree's private gitdir.",
  version: "0.2.0",
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
      .describe("Run the `worktree.setup` hooks from the base tree's agentproto.json after creation. Default true; a failing setup hook fails provisioning."),
  }),
  outputSchema: z.object({
    cwd: z.string().describe("Absolute path to the created worktree."),
    branch: z.string().describe("The branch the worktree was created on."),
  }),
  mutates: ["fs:write"],
  approval: "auto",
  riskLevel: 1,
})
