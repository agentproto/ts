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
    "repos) so the workspace graph resolves without a full reinstall. Also " +
    "writes a creation-provenance marker into the worktree's private gitdir.",
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
